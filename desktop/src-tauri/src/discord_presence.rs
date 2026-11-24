//! Local Discord RPC runs on its own thread. No socket I/O runs on the audio thread.
use crate::common::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock, atomic::Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

static STATUS: OnceLock<Mutex<Value>> = OnceLock::new();
pub fn status() -> Value {
    STATUS.get_or_init(|| Mutex::new(json!({"connected":false,"message":"Chưa bật Discord Rich Presence."}))).lock().unwrap().clone()
}
fn report(connected: bool, message: &str, activity: &Value) {
    *STATUS.get_or_init(|| Mutex::new(Value::Null)).lock().unwrap() = json!({"connected":connected,"message":message,"activity":activity});
}
pub fn valid_application_id(value: &str) -> bool {
    (17..=20).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_digit()) && !value.starts_with('0')
}
fn short(value: &str, bytes: usize) -> String {
    let mut result = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if result.len() + c.len_utf8() > bytes { break; }
        result.push(c);
    }
    result
}
pub fn quality(track: &Value) -> String {
    let mut parts = vec![s(track,"container").to_owned()];
    let codec = s(track,"codec");
    if !codec.is_empty() && !codec.eq_ignore_ascii_case(s(track,"container")) { parts.push(codec.into()); }
    let rate = n(track,"sampleRate");
    if rate > 0. { parts.push(format!("{} kHz", rate / 1000.)); }
    // AAC/MP3 bit depth is not source precision, even if the decoder outputs float PCM.
    if b(track,"lossless") && n(track,"bitsPerSample") > 0. { parts.push(format!("{}-bit",n(track,"bitsPerSample") as u32)); }
    if n(track,"bitrate") > 0. { parts.push(format!("{} kbps",(n(track,"bitrate") / 1000.).round() as u32)); }
    parts.retain(|p| !p.is_empty());
    parts.join(" · ")
}
fn clock(seconds: f64) -> String { let s = seconds.max(0.) as u64; format!("{}:{:02}",s/60,s%60) }
pub fn activity(track: &Value, playback: &Value, show_quality: bool, now: i64) -> Value {
    if s(playback,"trackId").is_empty() || !playback["error"].is_null() { return Value::Null; }
    let playing = b(playback,"playing");
    let duration = n(playback,"duration").max(0.);
    let position = n(playback,"position").max(0.).min(duration);
    if !playing && (duration <= 0. || position >= duration - 0.05) { return Value::Null; }
    let artist = short(s(track,"artist"),48);
    let state = if show_quality { format!("{artist} · {}",quality(track)) } else { artist };
    let mut value = json!({"type":2,"details":short(s(track,"title"),128),"state":short(&state,128)});
    if playing && duration > 0. {
        let start = now - position.floor() as i64;
        value["timestamps"] = json!({"start":start,"end":start + duration.ceil() as i64});
    } else {
        value["state"] = json!(short(&format!("Tạm dừng {} / {} · {state}",clock(position),clock(duration)),128));
    }
    // Embedded/private artwork is never uploaded to a hosting service.
    if s(track,"coverUrl").starts_with("https://") {
        value["assets"] = json!({"large_image":s(track,"coverUrl"),"large_text":short(s(track,"album"),128)});
    }
    value
}
fn same_activity(previous: &Value, next: &Value) -> bool {
    let mut a=previous.clone(); let mut b=next.clone();
    if let (Some(x),Some(y))=(a["timestamps"]["start"].as_i64(),b["timestamps"]["start"].as_i64()) {
        if (x-y).abs()>2 { return false; }
        a.as_object_mut().unwrap().remove("timestamps"); b.as_object_mut().unwrap().remove("timestamps");
    }
    a==b
}
fn should_publish(active:bool,elapsed:Duration,previous:&Value,next:&Value)->bool {
    // Discord's activity API permits five updates per twenty seconds. Keep the newest
    // playback snapshot and space updates at least five seconds apart.
    elapsed>=Duration::from_secs(5) && (!active || !same_activity(previous,next) || elapsed>=Duration::from_secs(15))
}
fn frame(opcode: u32, payload: &Value) -> Result<Vec<u8>> {
    let bytes=serde_json::to_vec(payload).map_err(err)?;
    if bytes.len()>65536 {return Err("Discord RPC payload quá lớn.".into());}
    let mut result=Vec::with_capacity(bytes.len()+8);
    result.extend_from_slice(&opcode.to_le_bytes()); result.extend_from_slice(&(bytes.len() as u32).to_le_bytes()); result.extend(bytes); Ok(result)
}
struct Wire<S> { io:S, incoming:Vec<u8> }
impl<S> Wire<S> {fn new(io:S)->Self {Self{io,incoming:Vec::with_capacity(4096)}}}
async fn send<S: AsyncWrite+Unpin>(stream:&mut Wire<S>,opcode:u32,payload:&Value)->Result<()> {
    let bytes=frame(opcode,payload)?;
    tokio::time::timeout(Duration::from_secs(2),stream.io.write_all(&bytes)).await.map_err(|_|"Discord không nhận dữ liệu.".to_string())?.map_err(err)
}
async fn receive<S: AsyncRead+Unpin>(stream:&mut Wire<S>)->Result<(u32,Value)> {
    loop {
        if stream.incoming.len()>=8 {
            let opcode=u32::from_le_bytes(stream.incoming[..4].try_into().unwrap());
            let size=u32::from_le_bytes(stream.incoming[4..8].try_into().unwrap()) as usize;
            if size>65536 {return Err("Discord RPC frame quá lớn.".into());}
            if stream.incoming.len()>=size+8 {
                let result=serde_json::from_slice(&stream.incoming[8..8+size]).map_err(err)?;
                stream.incoming.drain(..8+size);return Ok((opcode,result));
            }
        }
        // read_buf is cancellation-safe: idle polling cannot lose a partial header/frame.
        if stream.io.read_buf(&mut stream.incoming).await.map_err(err)?==0 {return Err("Discord đã ngắt kết nối.".into());}
    }
}
async fn reply<S:AsyncRead+AsyncWrite+Unpin>(stream:&mut Wire<S>,nonce:Option<&str>)->Result<()> {
    tokio::time::timeout(Duration::from_secs(2),async {
        for _ in 0..16 {
            let (opcode,value)=receive(stream).await?;
            if opcode==3 {send(stream,4,&value).await?;continue;}
            if opcode==2 {return Err("Discord đã đóng kết nối.".into());}
            if opcode!=1 {continue;}
            if s(&value,"evt")=="ERROR" {return Err(format!("Discord: {}",short(s(&value["data"],"message"),160)));}
            if nonce.map_or(s(&value,"evt")=="READY",|n|s(&value,"nonce")==n) {return Ok(());}
        }
        Err("Discord không trả lời yêu cầu.".into())
    }).await.map_err(|_|"Discord phản hồi quá thời gian.".to_string())?
}
async fn publish<S:AsyncRead+AsyncWrite+Unpin>(stream:&mut Wire<S>,activity:&Value)->Result<()> {
    let nonce=id(); send(stream,1,&json!({"cmd":"SET_ACTIVITY","args":{"pid":std::process::id(),"activity":activity},"nonce":nonce})).await?;
    reply(stream,Some(&nonce)).await
}

#[cfg(windows)] async fn connect(application_id:&str)->Result<Wire<tokio::net::windows::named_pipe::NamedPipeClient>> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut error="Không tìm thấy Discord desktop. Hãy mở Discord và đăng nhập.".to_owned();
    for index in 0..10 {
        if let Ok(pipe)=ClientOptions::new().open(format!(r"\\?\pipe\discord-ipc-{index}")) {
            let mut pipe=Wire::new(pipe);
            let result=async {send(&mut pipe,0,&json!({"v":1,"client_id":application_id})).await?;reply(&mut pipe,None).await}.await;
            match result {Ok(())=>return Ok(pipe),Err(e)=>error=e}
        }
    }
    Err(error)
}
pub fn start(app:Arc<App>) {
    if app.test_mode {return;}
    #[cfg(windows)] std::thread::spawn(move || {
        let runtime=match tokio::runtime::Builder::new_current_thread().enable_all().build(){Ok(r)=>r,Err(e)=>{report(false,&e.to_string(),&Value::Null);return;}};
        runtime.block_on(async move {
            let mut connection=None; let mut application_id=String::new(); let mut previous=Value::Null;
            let mut retry_at=Instant::now();let mut sent_at=Instant::now()-Duration::from_secs(60);let mut active=false;
            while !app.closing.load(Ordering::Relaxed) {
                let settings={let library=app.library.lock().unwrap();let raw=&library["settings"];
                    json!({"discordEnabled":raw["discordEnabled"],"discordApplicationId":raw["discordApplicationId"],"discordShowQuality":raw["discordShowQuality"]})};
                let enabled=b(&settings,"discordEnabled");let configured=s(&settings,"discordApplicationId");
                if !enabled || configured!=application_id {
                    if let Some(mut pipe)=connection.take(){let _=publish(&mut pipe,&Value::Null).await;}
                    application_id=configured.into();previous=Value::Null;active=false;retry_at=Instant::now();
                }
                if !enabled || !valid_application_id(configured) {
                    report(false,if enabled {"Nhập Discord Application ID trong Settings."}else{"Discord Rich Presence đang tắt."},&Value::Null);
                    tokio::time::sleep(Duration::from_millis(500)).await;continue;
                }
                let playback=app.audio.lock().unwrap().as_ref().map(|engine|engine.snapshot()).unwrap_or(Value::Null);
                // Copy only public metadata, never the multi-megabyte embedded cover or source path.
                let track={let library=app.library.lock().unwrap();library["tracks"].as_array().and_then(|tracks|tracks.iter().find(|t|s(t,"id")==s(&playback,"trackId"))).map(|track| {
                    let mut result=serde_json::Map::new();
                    for key in ["title","artist","album","container","codec","sampleRate","bitsPerSample","bitrate","lossless","coverUrl"] {if let Some(value)=track.get(key){result.insert(key.into(),value.clone());}}
                    Value::Object(result)
                })};
                let desired=track.as_ref().map(|track|activity(track,&playback,b(&settings,"discordShowQuality"),chrono::Utc::now().timestamp())).unwrap_or(Value::Null);
                if connection.is_none() && Instant::now()>=retry_at {
                    match connect(configured).await {Ok(pipe)=>{connection=Some(pipe);previous=Value::Null;sent_at=Instant::now()-Duration::from_secs(60);active=false;},Err(e)=>{report(false,&e,&Value::Null);retry_at=Instant::now()+Duration::from_secs(5);}}
                }
                if should_publish(active,sent_at.elapsed(),&previous,&desired) {
                    if let Some(pipe)=connection.as_mut() {
                        match publish(pipe,&desired).await {
                            Ok(())=>{previous=desired.clone();sent_at=Instant::now();active=true;report(true,if desired.is_null(){"Đã kết nối Discord · chưa phát nhạc."}else{"Đang chia sẻ bài nhạc trên Discord."},&desired);}
                            Err(e)=>{connection=None;active=false;retry_at=Instant::now()+Duration::from_secs(5);report(false,&e,&Value::Null);}
                        }
                    }
                }
                if let Some(pipe)=connection.as_mut() {
                    match tokio::time::timeout(Duration::from_millis(500),receive(pipe)).await {
                        Ok(Ok((3,value)))=>{if send(pipe,4,&value).await.is_err(){connection=None;retry_at=Instant::now()+Duration::from_secs(5);}},
                        Ok(Ok((2,_)))|Ok(Err(_))=>{connection=None;active=false;retry_at=Instant::now()+Duration::from_secs(5);report(false,"Discord đã ngắt kết nối; Luma sẽ tự kết nối lại.",&Value::Null);},
                        _=>{}
                    }
                } else {tokio::time::sleep(Duration::from_millis(500)).await;}
            }
            if let Some(mut pipe)=connection {let _=publish(&mut pipe,&Value::Null).await;}
        });
    });
}

#[cfg(test)] mod tests {
    use super::*;
    fn track()->Value {json!({"title":"Bài M4A","artist":"Artist","container":"M4A","codec":"AAC","sampleRate":44100,"bitsPerSample":32,"bitrate":256000,"lossless":false,"path":"C:/private/song.m4a","coverDataUrl":"data:image/png;base64,private"})}
    fn playback()->Value {json!({"trackId":"one","playing":true,"position":65.5,"duration":240.,"error":null})}
    #[test] fn aac_reports_bitrate_without_claiming_decoder_bit_depth_or_leaking_paths(){let a=activity(&track(),&playback(),true,1000);assert!(s(&a,"state").contains("M4A · AAC · 44.1 kHz · 256 kbps"));assert!(!s(&a,"state").contains("32-bit"));assert!(!a.to_string().contains("private"));assert_eq!(a["timestamps"]["start"],935);assert_eq!(a["timestamps"]["end"],1175);}
    #[test] fn alac_reports_source_precision_and_pause_has_no_running_timer(){let mut t=track();t["codec"]=json!("ALAC");t["lossless"]=json!(true);t["bitsPerSample"]=json!(24);t["sampleRate"]=json!(96000);let mut p=playback();p["playing"]=json!(false);let a=activity(&t,&p,true,1000);assert!(s(&a,"state").contains("96 kHz · 24-bit"));assert!(s(&a,"state").starts_with("Tạm dừng 1:05 / 4:00"));assert!(a.get("timestamps").is_none());}
    #[test] fn stop_and_error_clear_presence_and_seek_resets_timer(){let mut p=playback();let a=activity(&track(),&p,false,1000);assert!(!s(&a,"state").contains("AAC"));let b=activity(&track(),&p,false,1001);assert!(same_activity(&a,&b));p["position"]=json!(130.);assert!(!same_activity(&a,&activity(&track(),&p,false,1001)));p["playing"]=json!(false);p["position"]=json!(240.);assert!(activity(&track(),&p,true,1000).is_null());p["error"]=json!("Device lost");assert!(activity(&track(),&p,true,1000).is_null());}
    #[test] fn validation_and_utf8_limits(){assert!(valid_application_id("123456789012345678"));assert!(!valid_application_id("abc"));assert!(!valid_application_id("000000000000000000"));assert!(short(&"Nhạc 🎵".repeat(100),128).len()<=128);}
    #[test] fn updates_are_coalesced_to_respect_discord_rate_limits(){let before=activity(&track(),&playback(),true,1000);let mut after=before.clone();after["details"]=json!("Newest song");assert!(!should_publish(true,Duration::from_secs(1),&before,&after));assert!(should_publish(true,Duration::from_secs(5),&before,&after));assert!(!should_publish(true,Duration::from_secs(5),&before,&before));assert!(should_publish(true,Duration::from_secs(15),&before,&before));}
    #[test] fn rpc_handshake_frame_has_little_endian_header_and_bounded_payload(){let p=json!({"v":1,"client_id":"123456789012345678"});let f=frame(0,&p).unwrap();assert_eq!(&f[..4],&0u32.to_le_bytes());assert_eq!(u32::from_le_bytes(f[4..8].try_into().unwrap()) as usize,f.len()-8);assert_eq!(serde_json::from_slice::<Value>(&f[8..]).unwrap(),p);assert!(frame(1,&json!("x".repeat(70000))).is_err());}
    #[test] fn idle_polling_preserves_partial_frames(){let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();runtime.block_on(async {let (client,mut server)=tokio::io::duplex(4096);let mut client=Wire::new(client);let packet=frame(3,&json!({"ping":42})).unwrap();server.write_all(&packet[..5]).await.unwrap();assert!(tokio::time::timeout(Duration::from_millis(5),receive(&mut client)).await.is_err());assert_eq!(client.incoming.len(),5);server.write_all(&packet[5..]).await.unwrap();let (opcode,value)=receive(&mut client).await.unwrap();assert_eq!(opcode,3);assert_eq!(value["ping"],42);});}
    #[test] fn discord_rpc_errors_are_reported(){let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();runtime.block_on(async {let (client,server)=tokio::io::duplex(4096);let (mut client,mut server)=(Wire::new(client),Wire::new(server));let task=tokio::spawn(async move {let (_,p)=receive(&mut server).await.unwrap();send(&mut server,1,&json!({"nonce":p["nonce"],"evt":"ERROR","data":{"message":"Invalid application"}})).await.unwrap();});assert!(publish(&mut client,&Value::Null).await.unwrap_err().contains("Invalid application"));task.await.unwrap();});}
    #[test] fn rpc_acknowledgement_and_ping_are_handled_without_discord(){let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();runtime.block_on(async {let (client,server)=tokio::io::duplex(4096);let (mut client,mut server)=(Wire::new(client),Wire::new(server));let task=tokio::spawn(async move {let (op,p)=receive(&mut server).await.unwrap();assert_eq!(op,1);assert_eq!(p["cmd"],"SET_ACTIVITY");send(&mut server,3,&json!({"ping":1})).await.unwrap();let (op,_)=receive(&mut server).await.unwrap();assert_eq!(op,4);send(&mut server,1,&json!({"nonce":p["nonce"],"data":null})).await.unwrap();});publish(&mut client,&Value::Null).await.unwrap();task.await.unwrap();});}
}
