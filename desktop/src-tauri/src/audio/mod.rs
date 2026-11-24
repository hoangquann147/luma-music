//! Native dual-deck player. The UI and Windows media controls share this one owner.
pub(crate) mod decode;
mod dsp;
mod output;
use crate::common::*;
use crossbeam_channel::{bounded,Receiver,Sender};
use decode::Deck;
use dsp::{Equalizer,fade_gains};
use output::Output;
use serde_json::{json,Value};
use std::{path::Path,sync::{Arc,Mutex,atomic::Ordering},time::{Duration,Instant}};

enum Message { Command(Value,Sender<Result<Value>>), Stop }
type PreparedDeck = (Deck, Option<(String, f64)>);
#[derive(Clone)]
pub struct EngineHandle { sender:Sender<Message>, state:Arc<Mutex<Value>> }
impl EngineHandle {
    pub fn start(app:Arc<App>)->Result<Self>{
        let initial=default_state();let state=Arc::new(Mutex::new(initial));let(tx,rx)=bounded(128);let copy=state.clone();
        std::thread::Builder::new().name("luma-audio".into()).spawn(move||Worker::new(app,copy).run(rx)).map_err(err)?;
        Ok(Self{sender:tx,state})
    }
    pub fn command(&self,request:Value)->Result<Value>{
        let(tx,rx)=bounded(1);self.sender.send_timeout(Message::Command(request,tx),Duration::from_secs(2)).map_err(|_|"Engine âm thanh đang bận hoặc đã đóng.".to_string())?;
        rx.recv_timeout(Duration::from_secs(8)).map_err(|_|"Engine âm thanh chưa phản hồi; hãy kiểm tra thiết bị đầu ra.".to_string())?
    }
    pub fn snapshot(&self)->Value{self.state.lock().unwrap().clone()}
    pub fn stop(&self){let _=self.sender.try_send(Message::Stop);}
}
fn default_state()->Value{json!({"playing":false,"position":0.0,"duration":0.0,"volume":0.7,"queueIds":[],"shuffle":false,"repeatMode":"off","requestedMode":"shared","outputMode":"shared","bitPerfect":false,"sampleRate":0,"bitsPerSample":0,"channels":0,"crossfading":false,"muted":false,"decodedFrames":0,"transitionCount":0})}
struct Worker {
    app:Arc<App>,published:Arc<Mutex<Value>>,current:Option<Deck>,upcoming:Option<Deck>,preload:Option<(String,Receiver<Result<PreparedDeck>>)>,
    output:Option<Output>,queue:Vec<String>,ordered_queue:Vec<String>,shuffle:bool,repeat:String,playing:bool,volume:f64,settings:Value,eq_value:Value,eq:Equalizer,
    error:Option<String>,notice:Option<String>,crossfade_progress:f64,crossfade_length:f64,transition_count:u64,decoded_frames:u64,
    changed:bool,last_emit:Instant,initialization_error:Option<String>,force_shared:bool,
}
impl Worker {
    fn new(app:Arc<App>,published:Arc<Mutex<Value>>)->Self{
        let settings=app.settings();Self{app,published,current:None,upcoming:None,preload:None,output:None,queue:Vec::new(),ordered_queue:Vec::new(),shuffle:false,repeat:"off".into(),playing:false,volume:0.7,settings,
            eq_value:json!({"enabled":false,"preampDb":0,"autoHeadroom":true,"gains":[0,0,0,0,0,0,0,0,0,0]}),eq:Equalizer::default(),error:None,notice:None,
            crossfade_progress:0.0,crossfade_length:0.0,transition_count:0,decoded_frames:0,changed:true,last_emit:Instant::now(),initialization_error:None,force_shared:false}
    }
    fn run(mut self,rx:Receiver<Message>){
        self.initialization_error=output::initialize_thread().err();
        while !self.app.closing.load(Ordering::Relaxed) {
            let request=if self.playing{rx.try_recv().ok()}else{rx.recv_timeout(Duration::from_millis(50)).ok()};
            if let Some(message)=request{
                match message{
                    Message::Stop=>break,
                    Message::Command(command,reply)=>{
                        let result=self.apply(command);
                        if let Err(e)=&result{self.error=Some(e.clone());self.changed=true;}
                        self.publish(true);
                        let _=reply.send(result.map(|_|self.published.lock().unwrap().clone()));
                    }
                }
            }
            if self.playing {
                self.poll_preload();
                if let Err(e)=self.render(){self.recover_output(e);}
            }
            self.publish(false);
        }
        self.output=None;self.playing=false;self.publish(true);
    }
    fn apply(&mut self,input:Value)->Result<()> {
        match s(&input,"op") {
            "play"=>{
                let id=text(&input["trackId"],80)?;valid_id(&id)?;
                if input.get("queueIds").is_some(){self.set_queue(&input["queueIds"])?;}
                if !self.queue.contains(&id){self.queue.push(id.clone());self.ordered_queue.push(id.clone());}
                if self.shuffle {self.rebuild_queue(Some(&id));}
                self.force_shared=false;self.load(&id,0.0,true)?;
            }
            "setQueue"=>{self.set_queue(&input["queueIds"])?;self.upcoming=None;self.preload=None;self.crossfade_length=0.0;}
            "shuffle"=>{
                self.shuffle=input["enabled"].as_bool().ok_or("Trạng thái trộn bài không hợp lệ.")?;
                let current=self.current.as_ref().map(|d|d.id.clone());self.rebuild_queue(current.as_deref());
                self.upcoming=None;self.preload=None;self.crossfade_length=0.0;
            }
            "repeat"=>{
                let mode=s(&input,"mode");if !matches!(mode,"off"|"all"|"one"){return Err("Chế độ lặp lại không hợp lệ.".into())}
                self.repeat=mode.into();if self.repeat=="one"{if let Some(current)=&mut self.current{current.end=current.duration;}}
                self.upcoming=None;self.preload=None;self.crossfade_length=0.0;
            }
            "pause"=>self.pause()?,
            "resume"=>self.resume()?,
            "toggle"=>if self.playing{self.pause()?}else{self.resume()?},
            "next"=>self.skip(1,false)?,
            "previous"=>{
                if self.current.as_ref().is_some_and(|d|d.position>3.0){self.seek(0.0)?}else{self.skip(-1,false)?}
            }
            "seek"=>{let position=n(&input,"position");if !position.is_finite()||position<0.0{return Err("Vị trí tua không hợp lệ.".into())}self.seek(position)?;}
            "volume"=>{let volume=input["volume"].as_f64().ok_or("Thiếu âm lượng.")?;if !volume.is_finite()||!(0.0..=1.0).contains(&volume){return Err("Âm lượng cần trong khoảng 0–1.".into())}self.volume=volume;}
            "equalizer"=>{
                let value=input.get("settings").ok_or("Thiếu thông số EQ.")?.clone();
                let rate=self.output.as_ref().map_or(48000,|o|o.rate);let channels=self.output.as_ref().map_or(2,|o|o.channels);
                self.eq.configure(&value,rate,channels)?;self.eq_value=value;
            }
            "configure"=>{
                let old=b(&self.settings,"exclusiveMode");self.settings=self.app.settings();
                if old!=b(&self.settings,"exclusiveMode"){
                    self.force_shared=false;
                    if let Some(deck)=&self.current {let(id,pos,playing)=(deck.id.clone(),deck.position,self.playing);self.load(&id,pos,playing)?;}
                }
                if let Some(current)=&mut self.current {current.end=current.duration;}
                self.upcoming=None;self.preload=None;self.crossfade_length=0.0;
            }
            "stop"=>{self.pause()?;self.current=None;self.upcoming=None;self.preload=None;self.output=None;self.crossfade_length=0.0;}
            _=>return Err("Lệnh phát nhạc không hợp lệ.".into()),
        }
        self.changed=true;Ok(())
    }
    fn set_queue(&mut self,value:&Value)->Result<()> {
        let values=value.as_array().ok_or("Hàng đợi không hợp lệ.")?;if values.len()>10000{return Err("Hàng đợi tối đa 10.000 bài.".into())}
        let mut queue=Vec::new();
        for v in values {let id=text(v,80)?;valid_id(&id)?;if self.app.track(&id).is_none(){continue}if !queue.contains(&id){queue.push(id)}}
        self.ordered_queue=queue;
        let current=self.current.as_ref().map(|d|d.id.clone());self.rebuild_queue(current.as_deref());Ok(())
    }
    fn rebuild_queue(&mut self,anchor:Option<&str>){
        self.queue=self.ordered_queue.clone();
        if !self.shuffle {return}
        let start=if let Some(index)=anchor.and_then(|id|self.queue.iter().position(|item|item==id)){let current=self.queue.remove(index);self.queue.insert(0,current);1}else{0};
        for index in ((start+1)..self.queue.len()).rev(){
            let random=uuid::Uuid::new_v4().as_u128();let other=start+(random%(index-start+1) as u128) as usize;self.queue.swap(index,other);
        }
    }
    fn load(&mut self,id:&str,position:f64,playing:bool)->Result<()> {
        if let Some(e)=&self.initialization_error{return Err(format!("Không khởi tạo được WASAPI: {e}"))}
        let track=self.app.track(id).ok_or("Bài hát không còn trong thư viện.")?;
        let duration=n(&track,"duration");let position=position.min((duration-0.001).max(0.0));
        let deck=Deck::open(id.to_owned(),Path::new(s(&track,"path")),duration,position,duration)?;
        // Release the previous exclusive client before negotiating another file's native format.
        self.output=None;self.playing=false;
        let requested=b(&self.settings,"exclusiveMode")&&!self.force_shared;
        let (output,notice)=match Output::open(deck.rate,deck.channels,deck.bits,requested){
            Ok(output)=>(output,None),
            Err(e) if requested=>{
                let fallback=Output::open(deck.rate,deck.channels,deck.bits,false).map_err(|shared|format!("Exclusive: {e}. Shared cũng không mở được: {shared}"))?;
                (fallback,Some(format!("Không mở được WASAPI Exclusive (định dạng không hỗ trợ hoặc thiết bị đang bận). Đã chuyển sang Shared: {e}")))
            }
            Err(e)=>return Err(format!("Không mở được thiết bị âm thanh Shared: {e}")),
        };
        self.eq.configure(&self.eq_value,output.rate,output.channels)?;
        self.notice=notice;
        if output.exclusive {self.notice=Some("WASAPI Exclusive: giữ sample rate/độ sâu bit gốc; volume phần mềm, EQ, Crossfade và Automix được bypass. Điều chỉnh âm lượng trên DAC/amp.".into());}
        self.output=Some(output);self.current=Some(deck);self.upcoming=None;self.preload=None;self.crossfade_length=0.0;self.crossfade_progress=0.0;
        self.playing=playing;self.error=None;self.changed=true;Ok(())
    }
    fn pause(&mut self)->Result<()>{if let Some(output)=&mut self.output{output.pause()?;}self.playing=false;Ok(())}
    fn resume(&mut self)->Result<()>{
        if self.current.is_none(){if let Some(id)=self.queue.first().cloned(){return self.load(&id,0.0,true)}return Ok(())}
        if let Some(deck)=&self.current {if deck.position>=deck.end {let id=deck.id.clone();return self.load(&id,0.0,true)}}
        if let Some(output)=&mut self.output {output.resume()?;} else if let Some(deck)=&self.current {let(id,pos)=(deck.id.clone(),deck.position);return self.load(&id,pos,true)}
        self.playing=true;self.error=None;Ok(())
    }
    fn seek(&mut self,position:f64)->Result<()>{
        if let Some(deck)=&self.current{let(id,playing)=(deck.id.clone(),self.playing);self.load(&id,position,playing)?;}Ok(())
    }
    fn next_id(&self)->Option<String>{
        let key=self.current.as_ref()?.id.as_str();let index=self.queue.iter().position(|id|id==key)?;
        if self.repeat=="one" {return Some(key.to_owned())}
        self.queue.get(index+1).or_else(||if self.repeat=="all"{self.queue.first()}else{None}).cloned()
    }
    fn skip(&mut self,direction:i32,automatic:bool)->Result<()> {
        if self.queue.is_empty(){return Ok(())}
        let index=self.current.as_ref().and_then(|d|self.queue.iter().position(|id|id==&d.id));
        let target=if direction>0{
            let next=index.map_or(0,|i|i+1);if automatic&&next>=self.queue.len(){self.pause()?;return Ok(())}next%self.queue.len()
        }else{index.map_or(self.queue.len()-1,|i|(i+self.queue.len()-1)%self.queue.len())};
        let id=self.queue[target].clone();self.load(&id,0.0,true)
    }
    fn poll_preload(&mut self){
        if let Some((_,rx))=&self.preload {
            if let Ok(result)=rx.try_recv(){self.preload=None;match result{Ok((deck,cue_out))=>{
                if let Some((id,end))=cue_out {if let Some(current)=&mut self.current {if current.id==id {current.end=end.max(current.position).min(current.duration);}}}
                self.upcoming=Some(deck);self.changed=true;
            },Err(e)=>{self.notice=Some(format!("Không nạp trước được bài tiếp theo: {e}"));self.changed=true;}}}
        }
        let Some(deck)=&self.current else{return};
        if deck.end-deck.position>20.0||self.upcoming.is_some()||self.preload.is_some(){return}
        let Some(id)=self.next_id() else{return};let Some(track)=self.app.track(&id) else{return};
        let automix=b(&self.settings,"automix")&&self.repeat!="one"&&!self.output.as_ref().is_some_and(|o|o.exclusive);
        let current_track=self.app.track(&deck.id);let(tx,rx)=bounded(1);let key=id.clone();
        self.preload=Some((key,rx));
        std::thread::spawn(move||{
            let duration=n(&track,"duration");let path=Path::new(s(&track,"path"));
            let bounds=if automix{decode::cue_bounds(path,duration)}else{Ok((0.0,duration))};
            // Deliver both cue points to the audio owner, rather than a UI-only event.
            // A stale analysis can never trim a different outgoing track.
            let cue_out=if automix {current_track.and_then(|current|decode::cue_bounds(Path::new(s(&current,"path")),n(&current,"duration")).ok().map(|(_,end)|(s(&current,"id").to_owned(),end)))}else{None};
            let result=bounds.and_then(|(start,end)|Deck::open(id,path,duration,start,end)).map(|deck|(deck,cue_out));
            let _=tx.send(result);
        });
    }
    fn render(&mut self)->Result<()> {
        let Some(mut output)=self.output.take() else{self.playing=false;return Ok(())};
        let result=(||->Result<()> {
            let frames=output.available()?;if frames==0{return Ok(())}if frames>65536{return Err("Buffer thiết bị lớn bất thường.".into())}
            let mut bytes=Vec::with_capacity(frames*output.channels*(output.container_bits as usize/8));
            for _ in 0..frames {
                let mut frame=match self.mix_frame(output.rate,output.channels,output.valid_bits,output.exclusive) {
                    Ok(frame)=>frame,
                    Err(e) if e.starts_with("__NATIVE_FORMAT_CHANGE__")||e.starts_with("__NEXT_TRACK__")=>{
                        // Preserve the tail already rendered in this packet before reopening.
                        bytes.resize(frames*output.channels*(output.container_bits as usize/8),0);
                        output.write(frames,&bytes)?;output.drain()?;return Err(e)
                    }
                    Err(e)=>return Err(e),
                };
                if !output.exclusive {self.eq.process(&mut frame);for sample in &mut frame{*sample*=self.volume;}}
                for sample in frame {output.append_sample(if self.app.test_mode{0.0}else{sample.clamp(-1.0,1.0)},&mut bytes);}
            }
            output.write(frames,&bytes)?;Ok(())
        })();
        self.output=Some(output);result
    }
    fn mix_frame(&mut self,rate:u32,channels:usize,valid_bits:u32,exclusive:bool)->Result<Vec<f64>> {
        let Some(current)=&mut self.current else{return Ok(vec![0.0;channels])};
        let requested=if exclusive||self.repeat=="one"||self.upcoming.as_ref().is_some_and(|next|next.id==current.id){0.0}else{n(&self.settings,"crossfadeSeconds").clamp(0.0,12.0)};
        let remaining=(current.end-current.position).max(0.0);
        if self.crossfade_length==0.0 && requested>0.0 && remaining<=requested && self.upcoming.is_some(){
            let next_duration=self.upcoming.as_ref().map_or(requested,|d|(d.end-d.position).max(0.0));
            self.crossfade_length=remaining.min(requested).min(next_duration/2.0).max(1.0/rate as f64);self.crossfade_progress=0.0;self.changed=true;
        }
        let old=current.frame(rate,channels)?;
        self.decoded_frames+=u64::from(old.is_some());
        if self.crossfade_length>0.0 {
            let next=self.upcoming.as_mut().map(|d|d.frame(rate,channels)).transpose()?.flatten();
            let progress=(self.crossfade_progress/self.crossfade_length).clamp(0.0,1.0);let(a,b)=fade_gains(progress);
            let mut frame=old.unwrap_or_else(||vec![0.0;channels]);if let Some(next)=next{for (x,y) in frame.iter_mut().zip(next){*x=*x*a+y*b;}}
            self.crossfade_progress+=1.0/rate as f64;
            if self.crossfade_progress>=self.crossfade_length{self.promote();}
            return Ok(frame)
        }
        if let Some(frame)=old{return Ok(frame)}
        if let Some(next)=self.upcoming.take(){
            if exclusive&&native_format_changed(&next,rate,channels,valid_bits){
                // Finish the old packet and reopen WASAPI on the next iteration through recovery.
                let id=next.id.clone();self.current=Some(next);return Err(format!("__NATIVE_FORMAT_CHANGE__{id}"))
            }
            self.current=Some(next);self.transition_count+=1;self.changed=true;
            return self.current.as_mut().unwrap().frame(rate,channels).map(|v|v.unwrap_or_else(||vec![0.0;channels]))
        }
        if let Some(next)=self.next_id(){
            // A slow disk can miss preloading. Reopening is safe and reported; never mix bad data.
            return Err(format!("__NEXT_TRACK__{next}"))
        }
        self.playing=false;self.changed=true;Ok(vec![0.0;channels])
    }
    fn promote(&mut self){self.current=self.upcoming.take();self.crossfade_length=0.0;self.crossfade_progress=0.0;self.transition_count+=1;self.changed=true;}
    fn recover_output(&mut self,error:String){
        if let Some(id)=error.strip_prefix("__NATIVE_FORMAT_CHANGE__").or_else(||error.strip_prefix("__NEXT_TRACK__")){
            let id=id.to_owned();if let Err(e)=self.load(&id,0.0,true){self.error=Some(e);self.playing=false;}return;
        }
        let was_exclusive=self.output.as_ref().is_some_and(|o|o.exclusive);
        if was_exclusive {
            if let Some(deck)=&self.current{
                let(id,pos)=(deck.id.clone(),deck.position);self.force_shared=true;
                match self.load(&id,pos,true){Ok(())=>self.notice=Some(format!("Exclusive bị gián đoạn; đã fallback Shared: {error}")),Err(e)=>{self.error=Some(e);self.playing=false;self.output=None;}}
            }
        }else{self.error=Some(error);self.playing=false;self.output=None;}
        self.changed=true;
    }
    fn publish(&mut self,force:bool){
        if !force&&!self.changed&&self.last_emit.elapsed()<Duration::from_millis(200){return}
        let output=self.output.as_ref();let exclusive=output.is_some_and(|o|o.exclusive);let current=self.current.as_ref();
        let state=json!({"trackId":current.map(|d|d.id.clone()),"playing":self.playing,"position":current.map_or(0.0,|d|d.position.min(d.duration)),"duration":current.map_or(0.0,|d|d.duration),"volume":self.volume,
            "queueIds":self.queue,"shuffle":self.shuffle,"repeatMode":self.repeat,"requestedMode":if b(&self.settings,"exclusiveMode"){"exclusive"}else{"shared"},"outputMode":if exclusive{"exclusive"}else{"shared"},
            "bitPerfect":exclusive&&!self.app.test_mode&&current.is_some_and(|d|output.is_some_and(|o|d.rate==o.rate&&d.channels==o.channels&&d.bits==o.valid_bits))&&current.and_then(|d|self.app.track(&d.id)).is_some_and(|t|b(&t,"lossless")),
            "sampleRate":output.map_or(0,|o|o.rate),"bitsPerSample":output.map_or(0,|o|o.valid_bits),"channels":output.map_or(0,|o|o.channels),"sourceSampleRate":current.map_or(0,|d|d.rate),"sourceBitsPerSample":current.map_or(0,|d|d.bits),
            "crossfading":self.crossfade_length>0.0,"error":self.error,"notice":self.notice,"muted":self.app.test_mode,"decodedFrames":self.decoded_frames,"transitionCount":self.transition_count,"cueIn":self.upcoming.as_ref().map(|d|d.position),"cueOut":current.map(|d|d.end)});
        *self.published.lock().unwrap()=state.clone();self.app.emit("music:playback-state",&state);self.changed=false;self.last_emit=Instant::now();
    }
}

fn native_format_changed(deck:&Deck,rate:u32,channels:usize,bits:u32)->bool {
    deck.rate!=rate||deck.channels!=channels||deck.bits!=bits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs,path::PathBuf};
    fn test_app()->(tempfile::TempDir,Arc<App>) {
        let temp=tempfile::tempdir().unwrap();
        let tools=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.build-tools/native/resources/tools");
        let app=Arc::new(crate::library::initialize(temp.path().join("profile"),tools,true).unwrap());
        (temp,app)
    }
    fn tone(app:&App,path:&Path,filter:&str,bits:u32) {
        crate::common::run(&app.tool("ffmpeg"),&["-v".into(),"error".into(),"-f".into(),"lavfi".into(),"-i".into(),filter.into(),"-ac".into(),"2".into(),"-c:a".into(),"flac".into(),"-sample_fmt".into(),if bits==16{"s16".into()}else{"s32".into()},"-bits_per_raw_sample".into(),bits.to_string(),path_string(path)],None,Duration::from_secs(20),|_|{}).unwrap();
    }
    #[test]
    fn shuffle_keeps_current_track_and_restores_original_order(){
        let(_temp,app)=test_app();let mut worker=Worker::new(app,Arc::new(Mutex::new(default_state())));
        let original=(0..20).map(|i|format!("track-{i}")).collect::<Vec<_>>();worker.ordered_queue=original.clone();worker.shuffle=true;
        worker.rebuild_queue(Some("track-7"));assert_eq!(worker.queue.first().unwrap(),"track-7");
        let mut expected=original.clone();let mut actual=worker.queue.clone();expected.sort();actual.sort();assert_eq!(actual,expected);
        worker.shuffle=false;worker.rebuild_queue(Some("track-7"));assert_eq!(worker.queue,original);
    }
    #[test]
    fn repeat_modes_select_correct_automatic_successor(){
        let(temp,app)=test_app();let path=temp.path().join("repeat.flac");
        tone(&app,&path,"sine=frequency=440:sample_rate=8000:duration=0.2",16);
        let mut worker=Worker::new(app,Arc::new(Mutex::new(default_state())));
        worker.current=Some(Deck::open("last".into(),&path,0.2,0.0,0.2).unwrap());worker.queue=vec!["first".into(),"last".into()];
        assert_eq!(worker.next_id(),None);
        worker.apply(json!({"op":"repeat","mode":"all"})).unwrap();assert_eq!(worker.next_id(),Some("first".into()));
        worker.apply(json!({"op":"repeat","mode":"one"})).unwrap();assert_eq!(worker.next_id(),Some("last".into()));
        assert!(worker.apply(json!({"op":"repeat","mode":"invalid"})).is_err());assert_eq!(worker.repeat,"one");
        assert!(worker.apply(json!({"op":"shuffle","enabled":"yes"})).is_err());
    }
    #[test]
    fn dual_deck_crossfade_promotes_next_track_without_silence() {
        let(temp,app)=test_app();let path=temp.path().join("tone.flac");
        tone(&app,&path,"sine=frequency=440:sample_rate=8000:duration=0.2",16);
        let mut worker=Worker::new(app,Arc::new(Mutex::new(default_state())));
        worker.settings["crossfadeSeconds"]=json!(0.05);
        worker.current=Some(Deck::open("first".into(),&path,0.2,0.0,0.2).unwrap());
        worker.upcoming=Some(Deck::open("second".into(),&path,0.2,0.0,0.2).unwrap());
        let mut overlap=false;let mut energy=0.0;
        for _ in 0..1900 {let frame=worker.mix_frame(8000,2,16,false).unwrap();overlap|=worker.crossfade_length>0.0;energy+=frame[0]*frame[0];}
        assert!(overlap);assert!(energy>1.0);assert_eq!(worker.transition_count,1);
        assert_eq!(worker.current.as_ref().unwrap().id,"second");
        assert!(worker.current.as_ref().unwrap().position>0.08);
    }
    #[test]
    fn exclusive_reopens_when_only_the_bit_depth_changes() {
        let(temp,app)=test_app();let path=temp.path().join("tone24.flac");
        tone(&app,&path,"sine=frequency=440:sample_rate=8000:duration=0.2",24);
        let mut worker=Worker::new(app,Arc::new(Mutex::new(default_state())));
        worker.current=Some(Deck::open("old".into(),&path,0.2,0.0,0.0).unwrap());
        worker.upcoming=Some(Deck::open("next".into(),&path,0.2,0.0,0.2).unwrap());
        assert!(worker.mix_frame(8000,2,16,true).unwrap_err().starts_with("__NATIVE_FORMAT_CHANGE__"));
        assert_eq!(worker.crossfade_length,0.0);
    }
    #[test]
    fn automix_applies_both_energy_cue_points_and_preserves_sources() {
        let(temp,app)=test_app();let mut tracks=Vec::new();let mut originals=Vec::new();
        for i in 0..2 {
            let path=temp.path().join(format!("cue-{i}.flac"));
            tone(&app,&path,&format!("sine=frequency={}:sample_rate=8000:duration=2,adelay=1000:all=1,apad=pad_dur=1",440+i*100),16);
            originals.push((path.clone(),fs::read(&path).unwrap()));tracks.push(app.add_file(&path,"local",None).unwrap());
        }
        app.save_settings(&json!({"automix":true})).unwrap();
        let mut worker=Worker::new(app,Arc::new(Mutex::new(default_state())));
        worker.queue=tracks.iter().map(|t|s(t,"id").to_owned()).collect();
        worker.current=Some(Deck::open(worker.queue[0].clone(),Path::new(s(&tracks[0],"path")),4.0,0.0,4.0).unwrap());
        worker.poll_preload();let deadline=Instant::now()+Duration::from_secs(5);
        while worker.upcoming.is_none(){assert!(Instant::now()<deadline,"cue analysis timed out: {:?}",worker.notice);std::thread::sleep(Duration::from_millis(10));worker.poll_preload();}
        let next=worker.upcoming.as_ref().unwrap();
        assert!((next.position-1.0).abs()<0.04);assert!((next.end-3.0).abs()<0.04);
        assert!((worker.current.as_ref().unwrap().end-3.0).abs()<0.04);
        worker.app.save_settings(&json!({"automix":false})).unwrap();
        worker.apply(json!({"op":"configure"})).unwrap();
        assert_eq!(worker.current.as_ref().unwrap().end,4.0);
        for(path,before) in originals {assert_eq!(fs::read(path).unwrap(),before);}
    }
}
