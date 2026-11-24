import {useEffect,useState} from 'react';
import {Check,ExternalLink,Headphones,LoaderCircle} from 'lucide-react';
import type {DiscordStatus,Settings,SettingsUpdate} from '../../shared/types';

interface Props {settings:Settings;setSettings:(value:Settings)=>void;fail:(message:string)=>void;success:(message:string)=>void;requireDesktop:()=>boolean}
export default function DiscordSettings({settings,setSettings,fail,success,requireDesktop}:Props){
  const [applicationId,setApplicationId]=useState(settings.discordApplicationId??'');
  const [enabled,setEnabled]=useState(Boolean(settings.discordEnabled));
  const [showQuality,setShowQuality]=useState(settings.discordShowQuality!==false);
  const [saving,setSaving]=useState(false);
  const [status,setStatus]=useState<DiscordStatus>({connected:false,message:'Đang kiểm tra Discord…'});
  useEffect(()=>{setApplicationId(settings.discordApplicationId??'');setEnabled(Boolean(settings.discordEnabled));setShowQuality(settings.discordShowQuality!==false)},[settings]);
  useEffect(()=>{let alive=true;let pending=false;const read=async()=>{if(pending||!window.music)return;pending=true;try{const value=await window.music.discordStatus();if(alive)setStatus(value)}catch{if(alive)setStatus({connected:false,message:'Mở Luma PC để sử dụng Discord Rich Presence.'})}finally{pending=false}};void read();const timer=setInterval(()=>void read(),1500);return()=>{alive=false;clearInterval(timer)}},[]);
  const save=async(event:React.FormEvent)=>{event.preventDefault();if(!requireDesktop()||saving)return;setSaving(true);try{const patch:SettingsUpdate={discordEnabled:enabled,discordApplicationId:applicationId.trim(),discordShowQuality:showQuality};setSettings(await window.music!.saveSettings(patch));success('Đã lưu Discord Rich Presence.')}catch(error){fail(String(error))}finally{setSaving(false)}};
  const portal=async()=>{if(!requireDesktop())return;try{await window.music!.openExternal('https://discord.com/developers/applications')}catch(error){fail(String(error))}};
  return <form className="settings-category-form" onSubmit={event=>void save(event)}>
    <section className="settings-card">
      <div className="settings-section-title"><Headphones size={22}/><div><h3>Discord Rich Presence</h3><p>Hiển thị bài đang nghe trên hồ sơ Discord của bạn.</p></div></div>
      <label className="drive-auto-sync"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/><span><strong>Chia sẻ trạng thái nghe nhạc</strong><small>Tên bài, nghệ sĩ và đồng hồ theo tiến độ phát. Tạm dừng sẽ dừng đồng hồ; dừng bài sẽ ẩn hoạt động.</small></span></label>
      <label className="field-label" htmlFor="discord-application-id">Application ID</label>
      <input id="discord-application-id" className="settings-wide-input" value={applicationId} onChange={event=>setApplicationId(event.target.value)} inputMode="numeric" maxLength={20} pattern="[1-9][0-9]{16,19}" required={enabled} placeholder="Dán Application ID của Luma" autoComplete="off"/>
      <p className="settings-help">Tạo ứng dụng tên Luma trong Discord Developer Portal, rồi sao chép Application ID ở General Information. Không cần Bot Token hoặc Client Secret.</p>
      <button className="subtle-button" type="button" onClick={()=>void portal()}><ExternalLink size={15}/> Mở Discord Developer Portal</button>
      <label className="drive-auto-sync"><input type="checkbox" checked={showQuality} onChange={event=>setShowQuality(event.target.checked)}/><span><strong>Hiển thị thông số bài nhạc</strong><small>M4A / AAC hoặc ALAC · sample rate · bit depth của nguồn lossless · bitrate.</small></span></label>
    </section>
    <section className="settings-card"><h3>Trạng thái kết nối</h3><p role="status">{status.message}</p>{status.activity&&<div className="discord-preview"><strong>{status.activity.details}</strong><p>{status.activity.state}</p></div>}<p className="settings-help">Cần Discord desktop đang mở và cho phép chia sẻ hoạt động trong Activity Privacy. Discord quyết định cách hiển thị đồng hồ; Rich Presence không có đầy đủ giao diện riêng của Spotify.</p></section>
    <button className="settings-wide-save" type="submit" disabled={saving}>{saving?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>} Lưu Discord</button>
  </form>;
}
