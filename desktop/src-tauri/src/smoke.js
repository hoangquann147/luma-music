if (window.__LUMA_NATIVE_SMOKE__ && !window.__smokeStarted) {
  window.__smokeStarted = true;
  void (async () => {
    const report = {engine:'Rust/Tauri native WASAPI + WebView2',checks:[],errors:[],audioMuted:true};
    const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
    const until = async (fn,label,timeout=18000) => {
      const end=Date.now()+timeout;
      while(Date.now()<end){const result=await fn();if(result)return result;await sleep(60)}
      throw Error(label);
    };
    const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text);
    const command = input => window.music.audioCommand(input);
    const state = () => window.music.audioState();
    const desktop = action => window.__TAURI_INTERNALS__.invoke('music',{action:'desktopTest',args:[action]});
    const check = (name,ok,details={}) => {report.checks.push({name,ok,...details});if(!ok)throw Error(name)};
    try {
      await until(()=>window.music&&document.querySelector('.sidebar'),'App did not render');
      const data=await window.music.bootstrap();
      check('bootstrap',data.mediaBase?.startsWith('http://127.0.0.1:'));
      button('Library').click();await sleep(150);
      const importButton=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Import File'));
      if(!importButton)throw Error('Import button missing');importButton.click();
      await until(()=>document.querySelectorAll('.track-row').length>=2,'Imported tracks did not render');
      const tracks=(await window.music.bootstrap()).tracks;
      check('importUI',tracks.length>=2,{tracks:tracks.length});
      await window.music.saveSettings({crossfadeSeconds:1,automix:false,exclusiveMode:false,minimizeToTray:true});
      document.querySelector('.track-row button').click();
      let playing=await until(async()=>{const s=await state();return s.playing&&s.position>0.1&&s.decodedFrames>0&&!s.error?s:false},'Rust audio did not advance');
      check('nativeSharedPlayback',playing.outputMode==='shared'&&playing.muted,{sampleRate:playing.sampleRate,sourceRate:playing.sourceSampleRate,decodedFrames:playing.decodedFrames});
      let paused=await command({op:'pause'});await sleep(220);let after=await state();
      check('pause',!after.playing&&Math.abs(after.position-paused.position)<0.01);
      await command({op:'resume'});
      await until(async()=>{const s=await state();return s.playing&&s.position>paused.position+0.15},'Resume did not advance');
      check('resume',true);
      const seek=await command({op:'seek',position:1.25});check('seek',Math.abs(seek.position-1.25)<0.1);
      button('Trộn bài').click();await until(async()=>(await state()).shuffle,'Shuffle did not enable');
      let shuffled=await state();
      check('shuffleQueueIntegrity',shuffled.queueIds.length===tracks.length&&new Set(shuffled.queueIds).size===tracks.length&&shuffled.queueIds[0]===shuffled.trackId);
      button('Trộn bài').click();await until(async()=>!(await state()).shuffle,'Shuffle did not disable');
      button('Lặp lại').click();await until(async()=>(await state()).repeatMode==='all','Repeat all did not enable');
      button('Lặp lại').click();await until(async()=>(await state()).repeatMode==='one','Repeat one did not enable');
      const loopBefore=await state();await command({op:'seek',position:loopBefore.duration-0.35});
      const looped=await until(async()=>{const s=await state();return s.transitionCount>loopBefore.transitionCount&&s.trackId===loopBefore.trackId?s:false},'Repeat one did not restart the current track');
      check('repeatOnePlayback',looped.position<1&&!looped.crossfading);
      button('Lặp lại').click();await until(async()=>(await state()).repeatMode==='off','Repeat did not disable');
      await command({op:'repeat',mode:'all'});await command({op:'play',trackId:tracks[1].id,queueIds:[tracks[0].id,tracks[1].id]});
      const allBefore=(await state()).transitionCount;await command({op:'seek',position:5.65});
      await until(async()=>{const s=await state();return s.trackId===tracks[0].id&&s.transitionCount>allBefore},'Repeat all did not wrap the queue');
      check('repeatAllWrap',true);await command({op:'repeat',mode:'off'});
      await command({op:'play',trackId:tracks[0].id,queueIds:[tracks[0].id,tracks[1].id]});
      const before=(await state()).transitionCount;
      await until(async()=>(await state()).crossfading,'Crossfade never started');
      const transitioned=await until(async()=>{const s=await state();return s.trackId===tracks[1].id&&s.transitionCount>before?s:false},'Crossfade did not promote next deck');
      check('dualDeckCrossfade',transitioned.position>0.5,{position:transitioned.position,transitionCount:transitioned.transitionCount});
      await window.music.saveSettings({automix:true,crossfadeSeconds:0.5});
      await command({op:'play',trackId:tracks[0].id,queueIds:[tracks[0].id,tracks[1].id]});
      const cue=await until(async()=>{const s=await state();return s.cueIn>0.8&&s.cueOut<s.duration-0.8?s:false},'Automix cue points were not applied');
      check('automixCues',cue.cueIn<1.2&&cue.cueOut>cue.duration-1.2,{cueIn:cue.cueIn,cueOut:cue.cueOut,duration:cue.duration});
      const shell=await desktop('show');check('trayAndSMTC',shell.trayReady&&shell.smtcReady&&!shell.error,{...shell});
      await desktop('close');await sleep(650);
      const hidden=await desktop('status');const background=await state();
      check('backgroundAfterClose',!hidden.windowVisible&&background.playing&&background.position>cue.position+0.2);
      await desktop('show');check('restoreWindow',(await desktop('status')).windowVisible);
      await desktop('mediaToggle');await until(async()=>!(await state()).playing,'SMTC toggle did not pause');
      await desktop('mediaToggle');await until(async()=>(await state()).playing,'SMTC toggle did not resume');
      await desktop('mediaNext');await until(async()=>(await state()).trackId===tracks[1].id,'SMTC next failed');
      await command({op:'seek',position:0.2});
      await desktop('mediaPrevious');await until(async()=>(await state()).trackId===tracks[0].id,'SMTC previous failed');
      check('smtcCallbackTransport',true);
      await window.music.saveSettings({exclusiveMode:true});
      const mode=await until(async()=>{const s=await state();return s.playing&&s.position>0.1?s:false},'Exclusive request stopped playback');
      check('exclusiveOrExplicitFallback',mode.requestedMode==='exclusive'&&!mode.error&&(mode.outputMode==='exclusive'?mode.sampleRate===mode.sourceSampleRate&&mode.bitsPerSample===mode.sourceBitsPerSample:!!mode.notice),{outputMode:mode.outputMode,notice:mode.notice,sampleRate:mode.sampleRate,sourceRate:mode.sourceSampleRate});
      check('exclusiveDisablesMixing',!mode.crossfading);
      await window.music.saveSettings({exclusiveMode:false,automix:false,crossfadeSeconds:0});
      await command({op:'pause'});
      button('Albums').click();await sleep(150);check('albumsVisible',document.body.textContent.includes('Albums'));
      button('Settings').click();await sleep(150);
      check('settingsVisible',!!document.querySelector('.settings-layout'));
      const playback=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Phát nhạc'));
      if(playback)playback.click();await sleep(200);
      check('newPlaybackSettings',!!document.getElementById('crossfade-seconds'));
      check('labelsUnselectable',getComputedStyle(document.querySelector('.sidebar button')).userSelect==='none');
      const input=document.querySelector('input');check('inputsSelectable',!!input&&getComputedStyle(input).userSelect==='text');
      const textarea=document.createElement('textarea');document.body.append(textarea);
      check('textareasSelectable',getComputedStyle(textarea).userSelect==='text');textarea.remove();
      check('layout',document.documentElement.scrollWidth<=innerWidth+1,{viewport:[innerWidth,innerHeight]});
      await document.fonts.ready;
      check('offlineFontLoaded',document.fonts.check('600 14px "Be Vietnam Pro"')&&getComputedStyle(document.body).fontFamily.includes('Be Vietnam Pro'));
      const initialTheme=document.documentElement.dataset.theme;
      button('Đổi giao diện sáng tối').click();await sleep(100);
      check('themeToggle',document.documentElement.dataset.theme!==initialTheme&&localStorage.getItem('luma.theme')===document.documentElement.dataset.theme);
      button('Đổi giao diện sáng tối').click();await sleep(100);
      check('queueDocked',getComputedStyle(document.querySelector('.queue-panel')).position==='static'&&document.querySelector('.queue-panel').getBoundingClientRect().left>=document.querySelector('.main-view').getBoundingClientRect().right-1);
      button('Đóng hàng đợi').click();await sleep(100);check('queueCollapsed',!document.querySelector('.queue-panel'));
      button('Mở hàng đợi').click();await sleep(100);check('queueRestored',!!document.querySelector('.queue-panel'));
      button('Library').click();await sleep(100);
      button('Settings').click();await sleep(120);
      const discordCategory=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Discord Rich Presence'));
      discordCategory.click();await sleep(120);
      check('discordSettingsVisible',!!document.getElementById('discord-application-id'));
      let invalidRejected=false;try{await window.music.saveSettings({discordEnabled:true,discordApplicationId:'invalid'})}catch{invalidRejected=true}
      check('discordInvalidApplicationRejected',invalidRejected);
      const discordSaved=await window.music.saveSettings({discordEnabled:false,discordApplicationId:'123456789012345678',discordShowQuality:true});
      check('discordConfigurationPersisted',discordSaved.discordApplicationId==='123456789012345678'&&!discordSaved.discordEnabled);
      const rpc=await window.music.discordStatus();check('discordStatusAvailable',typeof rpc.connected==='boolean'&&typeof rpc.message==='string');
      report.ok=true;
    } catch(error) {report.errors.push(String(error));report.lastState=await state().catch(()=>null);report.ok=false}
    await window.__TAURI_INTERNALS__.invoke('music',{action:'smokeReport',args:[report]});
    if(!window.__LUMA_SMOKE_HOLD__){
      if(window.__LUMA_SMOKE_CLOSE__){await window.music.saveSettings({minimizeToTray:false});await desktop('close')}
      else await desktop('quit');
    }
  })();
}
