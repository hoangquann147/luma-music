package app.luma.music;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The audio page edits the same immutable settings consumed by the PCM processing thread. */
@SuppressWarnings("deprecation")
public final class AudioSettingsView extends ScrollView {
    private static final int INK=Color.rgb(48,55,70), MUTED=Color.rgb(137,145,160), BLUE=Color.rgb(77,111,161);
    private static final int LINE=Color.rgb(228,231,239), TINT=Color.rgb(237,242,250), PAPER=Color.rgb(248,248,252);
    private final Runnable onSettingsChanged;
    private final AudioManager audio;
    private AudioSettings settings;
    private LinearLayout page, bandEditor, outputCard, peqCard, levelCard;
    private TextView routeLabel, routeDetail, capabilityLabel, outputStatus, bypassNotice, bandSummary;
    private Switch exclusiveSwitch, eqSwitch;
    private CurveView curve;
    private final List<TextView> bandButtons=new ArrayList<>();
    private final List<View> dspControls=new ArrayList<>();
    private String outputInfo="";
    private boolean binding, registered;
    private int selectedBand;
    private final AudioDeviceCallback devicesChanged=new AudioDeviceCallback(){
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] devices){refreshOutput();}
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] devices){refreshOutput();}
    };

    public AudioSettingsView(Context context,Runnable onSettingsChanged){
        super(context); this.onSettingsChanged=onSettingsChanged; audio=context.getSystemService(AudioManager.class);
        settings=AudioSettings.load(context); setFillViewport(true); setClipToPadding(false); setBackgroundColor(PAPER); rebuild(false);
    }

    @Override protected void onAttachedToWindow(){super.onAttachedToWindow();if(audio!=null&&!registered){audio.registerAudioDeviceCallback(devicesChanged,new Handler(Looper.getMainLooper()));registered=true;}refreshOutput();}
    @Override protected void onDetachedFromWindow(){if(audio!=null&&registered){audio.unregisterAudioDeviceCallback(devicesChanged);registered=false;}super.onDetachedFromWindow();}

    public void updateOutputInfo(String info){String value=info==null?"":info;if(!outputInfo.equals(value)){outputInfo=value;refreshStatus();}}

    private void rebuild(boolean keepPosition){
        int scroll=keepPosition?getScrollY():0;binding=true;removeAllViews();dspControls.clear();bandButtons.clear();
        page=column();page.setPadding(dp(21),dp(2),dp(21),dp(28));addView(page,new ScrollView.LayoutParams(-1,-2));
        LinearLayout jump=row();jump.setPadding(0,0,0,dp(13));TextView outputJump=button("Đầu ra",false,()->scrollToCard(outputCard));TextView peqJump=button("PEQ",false,()->scrollToCard(peqCard));TextView levelJump=button("Mức tín hiệu",false,()->scrollToCard(levelCard));LinearLayout.LayoutParams jumpA=new LinearLayout.LayoutParams(0,dp(41),1);jumpA.rightMargin=dp(7);jump.addView(outputJump,jumpA);LinearLayout.LayoutParams jumpB=new LinearLayout.LayoutParams(0,dp(41),1);jumpB.rightMargin=dp(7);jump.addView(peqJump,jumpB);jump.addView(levelJump,new LinearLayout.LayoutParams(0,dp(41),1));page.addView(jump);
        buildOutput();buildPeq();buildLevel();buildNotes();binding=false;refreshOutput();refreshDspAvailability();
        if(keepPosition)post(()->scrollTo(0,scroll));
    }

    private void buildOutput(){
        LinearLayout card=card();outputCard=card;addCard(card,0);
        TextView tag=text("THE SIGNAL PATH",8,MUTED,true);tag.setLetterSpacing(.15f);card.addView(tag);
        TextView title=text("PCM & USB audio",21,INK,true);title.setPadding(0,dp(10),0,dp(8));card.addView(title);
        TextView subtitle=paragraph("Giải mã FLAC → PCM → đầu ra bạn chọn. Giữ tần số lấy mẫu của bài hát.",11);card.addView(subtitle);
        LinearLayout route=column();route.setPadding(dp(14),dp(14),dp(14),dp(14));route.setBackground(background(TINT,10,0));route.setFocusable(true);route.setContentDescription("Chọn thiết bị đầu ra âm thanh");
        routeLabel=text("Tự động theo Android  ›",12,BLUE,true);route.addView(routeLabel);routeDetail=paragraph("Loa, tai nghe hoặc USB DAC",10);routeDetail.setPadding(0,dp(6),0,0);route.addView(routeDetail);
        LinearLayout.LayoutParams routeParams=new LinearLayout.LayoutParams(-1,-2);routeParams.topMargin=dp(17);card.addView(route,routeParams);route.setOnClickListener(v->chooseOutput());
        exclusiveSwitch=toggle(card,"USB bit-perfect","Yêu cầu đường PCM không trộn và không DSP trên Android 14+ khi điện thoại cùng DAC hỗ trợ.",settings.usbBitPerfect,checked->{
            if(checked&&!canEnableBitPerfect()){toast("Chọn USB DAC có hỗ trợ bit-perfect. Khả năng này còn phụ thuộc Android và nhà sản xuất điện thoại.");binding=true;exclusiveSwitch.setChecked(false);binding=false;return;}
            settings=copy(settings.eqEnabled,settings.preampDb,settings.balance,settings.autoHeadroom,settings.bands,settings.outputDeviceId,checked,settings.pcmEncoding);commit();refreshDspAvailability();refreshOutput();
        });
        capabilityLabel=paragraph("",10);capabilityLabel.setPadding(0,0,0,dp(12));card.addView(capabilityLabel);
        TextView usbVolume=paragraph("Giảm âm lượng trên DAC trước khi bật bit-perfect. Điều khiển âm lượng Android có thể không còn tác dụng; PEQ và phần mềm điều chỉnh mức tín hiệu sẽ bị bỏ qua.",10);usbVolume.setPadding(0,0,0,dp(12));card.addView(usbVolume);
        LinearLayout pcm=clickRow("Định dạng PCM",pcmName(settings.pcmEncoding),this::choosePcm);card.addView(pcm);
        TextView pcmNote=paragraph("Auto ưu tiên độ sâu bit giải mã. Chọn 24/32-bit không làm tăng chất lượng của bản thu gốc; Android có thể giới hạn đầu ra.",10);pcmNote.setPadding(0,dp(3),0,dp(13));card.addView(pcmNote);
        line(card);outputStatus=paragraph("Phát một bài hát để xem định dạng và đường âm thanh thực tế.",10);outputStatus.setPadding(0,dp(13),0,0);outputStatus.setTextIsSelectable(true);card.addView(outputStatus);
        TextView diagnostics=button("Sao chép thông tin âm thanh",false,this::copyDiagnostics);LinearLayout.LayoutParams diagnosticsParams=new LinearLayout.LayoutParams(-1,dp(43));diagnosticsParams.topMargin=dp(13);card.addView(diagnostics,diagnosticsParams);
    }

    private void buildPeq(){
        LinearLayout card=card();peqCard=card;addCard(card,17);
        eqSwitch=toggle(card,"Parametric EQ","10 dải · Peak / Low shelf / High shelf",settings.eqEnabled,checked->{settings=copy(checked,settings.preampDb,settings.balance,settings.autoHeadroom,settings.bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);commit();refreshDspAvailability();curve.invalidate();});
        bypassNotice=paragraph("",10);bypassNotice.setPadding(0,0,0,dp(13));card.addView(bypassNotice);
        curve=new CurveView(getContext());curve.setBackground(background(Color.rgb(248,250,254),11,0));curve.setContentDescription("Đồ thị đáp tuyến bộ lọc PEQ, minh họa ở tần số lấy mẫu 48 kHz");card.addView(curve,new LinearLayout.LayoutParams(-1,dp(157)));
        TextView graphNote=paragraph("Đáp tuyến bộ lọc ở 48 kHz. Preamp, headroom và cân bằng kênh được áp dụng riêng khi phát.",9);graphNote.setPadding(0,dp(8),0,dp(14));card.addView(graphNote);
        LinearLayout actions=row();TextView presets=button("Preset  ▾",false,this::choosePreset);TextView save=button("Lưu preset",false,this::savePreset);TextView reset=button("Đặt lại",false,this::resetEq);
        LinearLayout.LayoutParams a=new LinearLayout.LayoutParams(0,dp(41),1);a.rightMargin=dp(7);actions.addView(presets,a);LinearLayout.LayoutParams b=new LinearLayout.LayoutParams(0,dp(41),1);b.rightMargin=dp(7);actions.addView(save,b);actions.addView(reset,new LinearLayout.LayoutParams(0,dp(41),1));card.addView(actions);dspControls.add(actions);
        HorizontalScrollView bands=new HorizontalScrollView(getContext());bands.setHorizontalScrollBarEnabled(false);LinearLayout bandRow=row();bandRow.setPadding(0,dp(19),0,dp(13));
        for(int i=0;i<settings.bands.length;i++){final int index=i;TextView item=text(String.format(Locale.ROOT,"%02d",i+1),11,BLUE,true);item.setGravity(Gravity.CENTER);item.setContentDescription("Chỉnh dải PEQ "+(i+1));item.setFocusable(true);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(dp(42),dp(37));p.rightMargin=dp(6);bandRow.addView(item,p);bandButtons.add(item);item.setOnClickListener(v->{selectedBand=index;buildBandEditor();curve.invalidate();});}
        bands.addView(bandRow);card.addView(bands);bandEditor=column();card.addView(bandEditor);buildBandEditor();
    }

    private void buildBandEditor(){
        if(bandEditor==null)return;boolean previousBinding=binding;binding=true;bandEditor.removeAllViews();
        for(int i=0;i<bandButtons.size();i++){TextView button=bandButtons.get(i);button.setBackground(background(i==selectedBand?BLUE:TINT,10,0));button.setTextColor(i==selectedBand?Color.WHITE:BLUE);}
        AudioSettings.Band band=settings.bands[selectedBand];
        Switch enabled=toggle(bandEditor,"Dải "+(selectedBand+1),"Bật hoặc bỏ qua riêng bộ lọc này.",band.enabled,value->replaceBand(band().type,band().frequencyHz,band().gainDb,band().q,value,true));
        bandEditor.addView(clickRow("Loại bộ lọc",typeName(band.type),()->{
            String[] names={"Peak · bell","Low shelf","High shelf"};String[] types={AudioSettings.BAND_PEAK,AudioSettings.BAND_LOW_SHELF,AudioSettings.BAND_HIGH_SHELF};int current=AudioSettings.BAND_LOW_SHELF.equals(band().type)?1:AudioSettings.BAND_HIGH_SHELF.equals(band().type)?2:0;
            new AlertDialog.Builder(getContext()).setTitle("Loại bộ lọc").setSingleChoiceItems(names,current,(dialog,which)->{replaceBand(types[which],band().frequencyHz,band().gainDb,band().q,band().enabled,true);dialog.dismiss();buildBandEditor();}).setNegativeButton("Đóng",null).show();
        }));
        slider(bandEditor,"Tần số",20,20000,band.frequencyHz,true,value->formatHz(value),value->replaceBand(band().type,value,band().gainDb,band().q,band().enabled,false));
        slider(bandEditor,"Gain",-12,12,band.gainDb,false,value->String.format(Locale.ROOT,"%+.1f dB",value),value->replaceBand(band().type,band().frequencyHz,value,band().q,band().enabled,false));
        slider(bandEditor,"Q",.1,10,band.q,true,value->String.format(Locale.ROOT,"%.2f",value),value->replaceBand(band().type,band().frequencyHz,band().gainDb,value,band().enabled,false));
        bandSummary=paragraph("",9);bandSummary.setPadding(0,dp(3),0,0);bandEditor.addView(bandSummary);refreshBandSummary();
        binding=previousBinding;setEnabledTree(bandEditor,!settings.usbBitPerfect&&settings.eqEnabled);
    }

    private void buildLevel(){
        LinearLayout card=card();levelCard=card;addCard(card,17);card.addView(text("Mức tín hiệu",16,INK,true));
        slider(card,"Preamp",-24,0,settings.preampDb,false,value->String.format(Locale.ROOT,"%.1f dB",value),value->{settings=copy(settings.eqEnabled,value,settings.balance,settings.autoHeadroom,settings.bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);});
        toggle(card,"Tự giảm mức khi tăng EQ","Ước tính phần tăng của đáp tuyến để tạo headroom. Đây không phải limiter cho mọi tín hiệu.",settings.autoHeadroom,checked->{settings=copy(settings.eqEnabled,settings.preampDb,settings.balance,checked,settings.bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);commit();});
        slider(card,"Cân bằng L / R",-1,1,settings.balance,false,value->{if(Math.abs(value)<.015)return "Giữa";return (value<0?"L ":"R ")+Math.round(Math.abs(value)*100)+"%";},value->{settings=copy(settings.eqEnabled,settings.preampDb,value,settings.autoHeadroom,settings.bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);});
        TextView note=paragraph("Preamp và headroom theo trạng thái PEQ. Cân bằng kênh hoạt động độc lập. USB bit-perfect bỏ qua toàn bộ xử lý này.",10);note.setPadding(0,dp(6),0,0);card.addView(note);dspControls.add(card);
    }

    private void buildNotes(){
        LinearLayout card=card();addCard(card,17);card.addView(text("Biết rõ đường âm thanh",14,INK,true));TextView note=paragraph("USB bit-perfect ở đây dùng khả năng chuẩn của Android 14+. Điện thoại hoặc DAC không hỗ trợ sẽ được báo rõ. Chế độ này không phải driver USB riêng của HiBy.\n\nKhi đổi thiết bị hoặc định dạng PCM, bài đang phát có thể ngắt ngắn để mở lại đầu ra. Rút DAC đã chọn sẽ dừng phát để tránh âm thanh chuyển bất ngờ sang loa.\n\nDSD native / DoP và giải mã MQA chưa có trong bản này. Dữ liệu FLAC luôn được giải mã thành PCM.",10);note.setPadding(0,dp(13),0,0);card.addView(note);
        TextView version=text("LUMA 1.4.0  ·  "+Build.MANUFACTURER+" "+Build.MODEL+"  ·  Android "+Build.VERSION.RELEASE,8,MUTED,false);version.setPadding(dp(3),dp(19),dp(3),0);page.addView(version);
    }

    private void chooseOutput(){
        List<UsbAudioOutput.Device> devices=UsbAudioOutput.devices(getContext());String[] names=new String[devices.size()+1];names[0]="Tự động theo Android";int current=0;
        for(int i=0;i<devices.size();i++){UsbAudioOutput.Device d=devices.get(i);names[i+1]=d.name+"\n"+d.detail;if(d.id==settings.outputDeviceId)current=i+1;}
        new AlertDialog.Builder(getContext()).setTitle("Thiết bị đầu ra").setSingleChoiceItems(names,current,(dialog,which)->{
            int id=which==0?0:devices.get(which-1).id;boolean usb=which>0&&devices.get(which-1).usb;boolean perfect=settings.usbBitPerfect&&usb;
            settings=copy(settings.eqEnabled,settings.preampDb,settings.balance,settings.autoHeadroom,settings.bands,id,perfect,settings.pcmEncoding);commit();dialog.dismiss();rebuild(true);
        }).setNegativeButton("Đóng",null).show();
    }

    private void choosePcm(){
        List<Integer> formats=new ArrayList<>();List<String> labels=new ArrayList<>();formats.add(0);labels.add("Auto · theo bộ giải mã");formats.add(AudioFormat.ENCODING_PCM_16BIT);labels.add("PCM 16-bit integer");formats.add(AudioFormat.ENCODING_PCM_FLOAT);labels.add("PCM 32-bit float");
        if(Build.VERSION.SDK_INT>=31){formats.add(AudioFormat.ENCODING_PCM_24BIT_PACKED);labels.add("PCM 24-bit packed");formats.add(AudioFormat.ENCODING_PCM_32BIT);labels.add("PCM 32-bit integer");}
        int selected=Math.max(0,formats.indexOf(settings.pcmEncoding));new AlertDialog.Builder(getContext()).setTitle("Định dạng PCM").setSingleChoiceItems(labels.toArray(new String[0]),selected,(dialog,which)->{
            settings=copy(settings.eqEnabled,settings.preampDb,settings.balance,settings.autoHeadroom,settings.bands,settings.outputDeviceId,settings.usbBitPerfect,formats.get(which));commit();dialog.dismiss();rebuild(true);
        }).setNegativeButton("Đóng",null).show();
    }

    private boolean canEnableBitPerfect(){
        if(Build.VERSION.SDK_INT<34)return false;for(UsbAudioOutput.Device d:UsbAudioOutput.devices(getContext()))if(d.id==settings.outputDeviceId)return d.usb&&d.bitPerfectCapable;return false;
    }

    private void refreshOutput(){
        if(routeLabel==null)return;String name="Tự động theo Android",detail="Theo thiết bị đầu ra hiện tại của hệ thống.";boolean found=settings.outputDeviceId==0;
        for(UsbAudioOutput.Device d:UsbAudioOutput.devices(getContext()))if(d.id==settings.outputDeviceId){name=d.name;detail=d.detail;found=true;break;}
        if(!found){name="Thiết bị đã chọn chưa kết nối";detail="Kết nối lại thiết bị hoặc chọn đầu ra khác để phát.";}
        routeLabel.setText(name+"  ›");routeDetail.setText(detail);capabilityLabel.setText(UsbAudioOutput.capabilitySummary(getContext()));
        binding=true;exclusiveSwitch.setChecked(settings.usbBitPerfect);binding=false;exclusiveSwitch.setEnabled(settings.usbBitPerfect||canEnableBitPerfect());exclusiveSwitch.setAlpha(exclusiveSwitch.isEnabled()?1:.48f);refreshStatus();
    }

    private void refreshStatus(){if(outputStatus!=null)outputStatus.setText(outputInfo.isEmpty()?"Phát một bài hát để xem định dạng và đường âm thanh thực tế.":outputInfo);}
    private void scrollToCard(View card){if(card!=null)smoothScrollTo(0,Math.max(0,card.getTop()-dp(2)));}

    private void copyDiagnostics(){
        StringBuilder report=new StringBuilder("Luma Android 1.4.0\n");report.append("Điện thoại: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("\nAndroid: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        report.append("Khả năng USB: ").append(UsbAudioOutput.capabilitySummary(getContext())).append("\nĐầu ra đã chọn: ").append(routeLabel.getText()).append("\nPCM: ").append(pcmName(settings.pcmEncoding)).append("\nYêu cầu bit-perfect: ").append(settings.usbBitPerfect).append("\nPEQ: ").append(settings.eqEnabled).append("; bypass do USB: ").append(settings.usbBitPerfect).append("\nTrạng thái phát: ").append(outputInfo.isEmpty()?"Chưa có luồng phát":outputInfo).append("\nThiết bị Android công bố:\n");
        for(UsbAudioOutput.Device device:UsbAudioOutput.devices(getContext()))report.append("- ").append(device.name).append(" · ").append(device.detail).append(" · BIT_PERFECT=").append(device.bitPerfectCapable).append('\n');
        ClipboardManager clipboard=getContext().getSystemService(ClipboardManager.class);if(clipboard!=null){clipboard.setPrimaryClip(ClipData.newPlainText("Luma audio diagnostics",report.toString()));toast("Đã sao chép thông tin âm thanh. Bạn có thể dán vào tin nhắn để kiểm tra DAC.");}
    }

    private void refreshDspAvailability(){
        if(eqSwitch==null)return;binding=true;eqSwitch.setChecked(settings.eqEnabled);binding=false;eqSwitch.setEnabled(!settings.usbBitPerfect);eqSwitch.setAlpha(settings.usbBitPerfect?.48f:1);
        bypassNotice.setText(settings.usbBitPerfect?"USB bit-perfect đang được yêu cầu: PEQ, preamp, headroom và cân bằng kênh đều tạm bỏ qua. Cài đặt của bạn vẫn được lưu.":settings.eqEnabled?"PEQ được xử lý trực tiếp trong Luma. Nhấn vào giá trị để nhập số chính xác.":"PEQ đang tắt. Bật công tắc để chỉnh và áp dụng các bộ lọc.");
        setEnabledTree(bandEditor,!settings.usbBitPerfect&&settings.eqEnabled);for(View v:dspControls)setEnabledTree(v,!settings.usbBitPerfect);if(curve!=null)curve.invalidate();
    }

    private void replaceBand(String type,double frequency,double gain,double q,boolean enabled,boolean save){
        AudioSettings.Band[] bands=settings.bands.clone();bands[selectedBand]=new AudioSettings.Band(type,frequency,gain,q,enabled);settings=copy(settings.eqEnabled,settings.preampDb,settings.balance,settings.autoHeadroom,bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);if(curve!=null)curve.invalidate();refreshBandSummary();if(save)commit();
    }
    private AudioSettings.Band band(){return settings.bands[selectedBand];}
    private void refreshBandSummary(){if(bandSummary!=null)bandSummary.setText("Dải "+(selectedBand+1)+" · "+typeName(band().type)+" · "+formatHz(band().frequencyHz)+" · "+String.format(Locale.ROOT,"%+.1f dB · Q %.2f",band().gainDb,band().q));}
    private AudioSettings copy(boolean eq,double preamp,double balance,boolean headroom,AudioSettings.Band[] bands,int device,boolean perfect,int encoding){return new AudioSettings(eq,preamp,balance,headroom,bands,device,perfect,encoding);}
    private void commit(){if(binding)return;settings.save(getContext());try{onSettingsChanged.run();}catch(RuntimeException error){toast("Đã lưu cài đặt. Chưa áp dụng được: "+error.getMessage());}}

    private void resetEq(){AudioSettings d=AudioSettings.defaults();settings=copy(settings.eqEnabled,d.preampDb,0,true,d.bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);commit();rebuild(true);toast("Đã đặt lại PEQ, preamp và cân bằng kênh.");}
    private SharedPreferences presetPrefs(){return getContext().getSharedPreferences("luma_peq_presets",Context.MODE_PRIVATE);}
    private JSONArray storedPresets(){try{return new JSONArray(presetPrefs().getString("presets","[]"));}catch(Exception ignored){return new JSONArray();}}

    private void choosePreset(){
        JSONArray custom=storedPresets();String[] labels=new String[custom.length()+4];labels[0]="Flat · trung tính";labels[1]="Bass nhẹ";labels[2]="Giọng hát";labels[3]="Ấm dịu";for(int i=0;i<custom.length();i++){JSONObject preset=custom.optJSONObject(i);labels[i+4]="Của tôi · "+(preset==null?"Preset lỗi":preset.optString("name","Preset "+(i+1)));}
        new AlertDialog.Builder(getContext()).setTitle("Chọn preset PEQ").setItems(labels,(dialog,which)->{
            try{
                AudioSettings.Band[] bands=AudioSettings.defaults().bands.clone();double preamp=0,balance=0;boolean headroom=true;
                if(which==1)bands[1]=new AudioSettings.Band(AudioSettings.BAND_LOW_SHELF,90,3,.707,true);
                else if(which==2){bands[3]=new AudioSettings.Band(AudioSettings.BAND_PEAK,250,-2,.8,true);bands[6]=new AudioSettings.Band(AudioSettings.BAND_PEAK,2200,2,.9,true);}
                else if(which==3){bands[1]=new AudioSettings.Band(AudioSettings.BAND_LOW_SHELF,140,2,.707,true);bands[8]=new AudioSettings.Band(AudioSettings.BAND_HIGH_SHELF,6500,-2,.707,true);}
                else if(which>=4){JSONObject data=custom.getJSONObject(which-4);preamp=data.optDouble("preamp",0);balance=data.optDouble("balance",0);headroom=data.optBoolean("headroom",true);JSONArray list=data.getJSONArray("bands");for(int i=0;i<Math.min(bands.length,list.length());i++){JSONObject b=list.getJSONObject(i);bands[i]=new AudioSettings.Band(b.optString("type",AudioSettings.BAND_PEAK),b.optDouble("frequency",1000),b.optDouble("gain",0),b.optDouble("q",1),b.optBoolean("enabled",true));}}
                settings=copy(true,preamp,balance,headroom,bands,settings.outputDeviceId,settings.usbBitPerfect,settings.pcmEncoding);commit();rebuild(true);toast("Đã áp dụng "+labels[which]+".");
            }catch(Exception error){toast("Không đọc được preset này.");}
        }).setNegativeButton("Đóng",null).show();
    }

    private void savePreset(){
        EditText input=new EditText(getContext());input.setSingleLine(true);input.setHint("Ví dụ: Tai nghe của tôi");input.setTextSize(15);input.setPadding(dp(18),dp(13),dp(18),dp(13));input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(60)});
        LinearLayout wrapper=column();wrapper.setPadding(dp(20),dp(5),dp(20),0);wrapper.addView(input,new LinearLayout.LayoutParams(-1,-2));
        AlertDialog dialog=new AlertDialog.Builder(getContext()).setTitle("Lưu preset PEQ").setMessage("Lưu các bộ lọc, preamp, headroom và cân bằng kênh. Tên trùng sẽ được cập nhật.").setView(wrapper).setNegativeButton("Hủy",null).setPositiveButton("Lưu",null).create();
        dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{String name=input.getText().toString().trim();if(name.isEmpty()){input.setError("Nhập tên preset");return;}try{
            JSONArray old=storedPresets(),next=new JSONArray();for(int i=0;i<old.length();i++)if(!name.equalsIgnoreCase(old.getJSONObject(i).optString("name")))next.put(old.getJSONObject(i));
            if(next.length()>=40){toast("Đã có 40 preset. Dùng lại một tên để cập nhật preset.");return;}
            JSONObject data=new JSONObject();data.put("name",name);data.put("preamp",settings.preampDb);data.put("balance",settings.balance);data.put("headroom",settings.autoHeadroom);JSONArray bands=new JSONArray();for(AudioSettings.Band band:settings.bands){JSONObject item=new JSONObject();item.put("type",band.type);item.put("frequency",band.frequencyHz);item.put("gain",band.gainDb);item.put("q",band.q);item.put("enabled",band.enabled);bands.put(item);}data.put("bands",bands);next.put(data);presetPrefs().edit().putString("presets",next.toString()).apply();dialog.dismiss();toast("Đã lưu preset “"+name+"”.");
        }catch(Exception error){toast("Chưa lưu được preset: "+error.getMessage());}}));dialog.show();
    }

    private interface NumberLabel{String format(double value);}private interface NumberChange{void changed(double value);}
    private void slider(LinearLayout parent,String title,double min,double max,double current,boolean log,NumberLabel format,NumberChange changed){
        final double[] exactValue={current};
        LinearLayout block=column();block.setPadding(0,dp(13),0,dp(1));LinearLayout heading=row();heading.addView(text(title,11,INK,true),new LinearLayout.LayoutParams(0,-2,1));TextView value=text(format.format(current)+"  ✎",11,BLUE,true);value.setPadding(dp(8),dp(5),dp(2),dp(5));value.setFocusable(true);value.setContentDescription("Nhập "+title+", "+format.format(current));heading.addView(value);block.addView(heading);
        SeekBar bar=new SeekBar(getContext());bar.setMax(1000);bar.setProgressTintList(ColorStateList.valueOf(BLUE));bar.setThumbTintList(ColorStateList.valueOf(BLUE));bar.setProgressBackgroundTintList(ColorStateList.valueOf(LINE));bar.setPadding(dp(8),0,dp(8),0);bar.setContentDescription(title);bar.setProgress(toProgress(current,min,max,log));
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){
            @Override public void onProgressChanged(SeekBar seek,int progress,boolean user){if(!user)return;double next=fromProgress(progress,min,max,log);if(!log)next=Math.rint(next*100)/100;exactValue[0]=next;value.setText(format.format(next)+"  ✎");value.setContentDescription("Nhập "+title+", "+format.format(next));changed.changed(next);}
            @Override public void onStartTrackingTouch(SeekBar seek){}
            @Override public void onStopTrackingTouch(SeekBar seek){commit();}
        });
        value.setOnClickListener(v->{EditText input=new EditText(getContext());input.setSingleLine(true);input.setInputType(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL|(min<0?InputType.TYPE_NUMBER_FLAG_SIGNED:0));input.setImeOptions(EditorInfo.IME_ACTION_DONE);input.setText(String.format(Locale.ROOT,"%.2f",exactValue[0]));input.selectAll();LinearLayout box=column();box.setPadding(dp(24),dp(4),dp(24),0);box.addView(input);
            AlertDialog dialog=new AlertDialog.Builder(getContext()).setTitle(title).setMessage(String.format(Locale.ROOT,"Nhập giá trị từ %s đến %s.",trimNumber(min),trimNumber(max))).setView(box).setNegativeButton("Hủy",null).setPositiveButton("Áp dụng",null).create();dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button->{try{double number=Double.parseDouble(input.getText().toString().trim().replace(',','.'));if(!Double.isFinite(number)||number<min||number>max)throw new NumberFormatException();exactValue[0]=number;changed.changed(number);bar.setProgress(toProgress(number,min,max,log));value.setText(format.format(number)+"  ✎");value.setContentDescription("Nhập "+title+", "+format.format(number));commit();dialog.dismiss();}catch(NumberFormatException error){input.setError("Giá trị phải từ "+trimNumber(min)+" đến "+trimNumber(max));}}));dialog.show();
        });
        block.addView(bar,new LinearLayout.LayoutParams(-1,dp(34)));parent.addView(block);
    }

    private interface ToggleChange{void changed(boolean checked);}
    private Switch toggle(LinearLayout parent,String title,String detail,boolean initial,ToggleChange changed){
        LinearLayout item=row();item.setPadding(0,dp(14),0,dp(14));LinearLayout words=column();words.addView(text(title,12,INK,true));TextView description=paragraph(detail,10);description.setPadding(0,dp(6),dp(12),0);words.addView(description);item.addView(words,new LinearLayout.LayoutParams(0,-2,1));
        Switch toggle=new Switch(getContext());toggle.setContentDescription(title);toggle.setChecked(initial);toggle.setThumbTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{BLUE,Color.rgb(174,182,197)}));toggle.setTrackTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{Color.rgb(195,211,236),Color.rgb(224,227,235)}));toggle.setOnCheckedChangeListener((button,checked)->{if(!binding)changed.changed(checked);});item.addView(toggle);parent.addView(item);return toggle;
    }

    private LinearLayout clickRow(String title,String value,Runnable action){LinearLayout item=row();item.setPadding(0,dp(13),0,dp(13));item.addView(text(title,11,INK,true),new LinearLayout.LayoutParams(0,-2,1));TextView label=text(value+"  ›",11,BLUE,true);label.setGravity(Gravity.END);LinearLayout.LayoutParams labelParams=new LinearLayout.LayoutParams(0,-2,1);item.addView(label,labelParams);item.setMinimumHeight(dp(44));item.setFocusable(true);item.setContentDescription(title+": "+value);item.setOnClickListener(v->action.run());return item;}
    private TextView button(String label,boolean primary,Runnable action){TextView button=text(label,10,primary?Color.WHITE:BLUE,true);button.setGravity(Gravity.CENTER);button.setPadding(dp(5),dp(5),dp(5),dp(5));button.setBackground(background(primary?BLUE:TINT,9,0));button.setFocusable(true);button.setOnClickListener(v->action.run());return button;}
    private void setEnabledTree(View view,boolean enabled){if(view==null)return;setDescendantsEnabled(view,enabled);view.setAlpha(enabled?1:.55f);}
    private void setDescendantsEnabled(View view,boolean enabled){view.setEnabled(enabled);view.setAlpha(1);if(view instanceof android.view.ViewGroup){android.view.ViewGroup group=(android.view.ViewGroup)view;for(int i=0;i<group.getChildCount();i++)setDescendantsEnabled(group.getChildAt(i),enabled);}}
    private void addCard(LinearLayout card,int margin){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(margin);page.addView(card,p);}
    private int dp(float n){return Math.round(n*getResources().getDisplayMetrics().density);}private void toast(String value){Toast.makeText(getContext(),value,Toast.LENGTH_LONG).show();}
    private LinearLayout column(){LinearLayout result=new LinearLayout(getContext());result.setOrientation(LinearLayout.VERTICAL);return result;}private LinearLayout row(){LinearLayout result=new LinearLayout(getContext());result.setOrientation(LinearLayout.HORIZONTAL);result.setGravity(Gravity.CENTER_VERTICAL);return result;}
    private TextView text(String value,float size,int color,boolean bold){TextView result=new TextView(getContext());result.setText(value);result.setTextSize(size);result.setTextColor(color);result.setIncludeFontPadding(false);result.setTypeface(Typeface.create(bold?"sans-serif-medium":"sans-serif",Typeface.NORMAL));return result;}private TextView paragraph(String value,float size){TextView result=text(value,size,MUTED,false);result.setLineSpacing(dp(3),1.08f);return result;}
    private LinearLayout card(){LinearLayout card=column();card.setPadding(dp(18),dp(19),dp(18),dp(18));card.setBackground(background(Color.WHITE,15,LINE));return card;}private GradientDrawable background(int color,int radius,int stroke){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));if(stroke!=0)d.setStroke(dp(1),stroke);return d;}private void line(LinearLayout card){View line=new View(getContext());line.setBackgroundColor(LINE);card.addView(line,new LinearLayout.LayoutParams(-1,dp(1)));}
    private static String formatHz(double value){return value>=1000?String.format(Locale.ROOT,"%.2f kHz",value/1000):String.format(Locale.ROOT,"%.0f Hz",value);}private static String trimNumber(double value){return value==(long)value?Long.toString((long)value):Double.toString(value);}private static String typeName(String type){return AudioSettings.BAND_LOW_SHELF.equals(type)?"Low shelf":AudioSettings.BAND_HIGH_SHELF.equals(type)?"High shelf":"Peak · bell";}
    private static int toProgress(double value,double min,double max,boolean log){double ratio=log?Math.log(Math.max(min,value)/min)/Math.log(max/min):(value-min)/(max-min);return (int)Math.round(Math.max(0,Math.min(1,ratio))*1000);}private static double fromProgress(int progress,double min,double max,boolean log){double ratio=Math.max(0,Math.min(1000,progress))/1000.0;return log?min*Math.pow(max/min,ratio):min+(max-min)*ratio;}
    private static String pcmName(int encoding){if(encoding==AudioFormat.ENCODING_PCM_16BIT)return "16-bit integer";if(encoding==AudioFormat.ENCODING_PCM_FLOAT)return "32-bit float";if(Build.VERSION.SDK_INT>=31&&encoding==AudioFormat.ENCODING_PCM_24BIT_PACKED)return "24-bit packed";if(Build.VERSION.SDK_INT>=31&&encoding==AudioFormat.ENCODING_PCM_32BIT)return "32-bit integer";return "Auto";}

    /** Uses the actual DSP's RBJ coefficients; only the explicitly labelled sample rate is illustrative. */
    private final class CurveView extends View{
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);private final Path path=new Path();
        CurveView(Context context){super(context);setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);float left=dp(33),top=dp(17),right=getWidth()-dp(14),bottom=getHeight()-dp(27);if(right<=left)return;paint.setTypeface(Typeface.create("sans-serif",Typeface.NORMAL));paint.setTextSize(dp(8));paint.setStrokeWidth(dp(1));
            for(int db=-12;db<=12;db+=6){float y=top+(12-db)/24f*(bottom-top);paint.setColor(db==0?Color.rgb(195,207,226):Color.rgb(226,233,244));canvas.drawLine(left,y,right,y,paint);paint.setColor(MUTED);paint.setStyle(Paint.Style.FILL);canvas.drawText(db>0?"+"+db:Integer.toString(db),dp(3),y+dp(3),paint);}
            double[] ticks={20,100,1000,10000,20000};String[] names={"20","100","1k","10k","20k"};for(int i=0;i<ticks.length;i++){float x=left+(float)(Math.log(ticks[i]/20)/Math.log(1000))*(right-left);paint.setColor(Color.rgb(231,236,245));canvas.drawLine(x,top,x,bottom,paint);paint.setColor(MUTED);float width=paint.measureText(names[i]);canvas.drawText(names[i],Math.max(left-width/2,Math.min(right-width,x-width/2)),bottom+dp(17),paint);}
            canvas.save();canvas.clipRect(left,top,right,bottom);path.reset();for(int i=0;i<=240;i++){double frequency=20*Math.pow(1000,i/240.0);double db=PeqProcessor.responseDb(settings,frequency,48000);float x=left+(right-left)*i/240f,y=top+(float)((12-db)/24)*(bottom-top);if(i==0)path.moveTo(x,y);else path.lineTo(x,y);}paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(2));paint.setColor(settings.eqEnabled&&!settings.usbBitPerfect?BLUE:Color.rgb(173,185,205));paint.setStrokeCap(Paint.Cap.ROUND);canvas.drawPath(path,paint);
            if(settings.eqEnabled&&!settings.usbBitPerfect){AudioSettings.Band band=band();float x=left+(float)(Math.log(Math.max(20,Math.min(20000,band.frequencyHz))/20)/Math.log(1000))*(right-left);float y=top+(float)((12-PeqProcessor.responseDb(settings,band.frequencyHz,48000))/24)*(bottom-top);paint.setStyle(Paint.Style.FILL);paint.setColor(BLUE);canvas.drawCircle(x,y,dp(3.5f),paint);}canvas.restore();paint.setStyle(Paint.Style.FILL);
        }
    }
}
