/* ============================================================
   EVO STUDIO — браузерная DAW
   ============================================================ */

/* ---------- AUDIO GLOBALS ---------- */
let audioCtx = null;
let masterGain = null;
let masterAnalyser = null;
let isPlaying = false;
let isLooping = true;
let bpm = 120;
let currentBeat = 0;
let schedulerTimer = null;
let nextNoteTime = 0;
let playStartTime = 0;
let activeSources = new Set();

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.8;
  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(audioCtx.destination);
}

/* ---------- STATE ---------- */
const state = {
  samples: [],      // {id,name,buffer,bpm}
  channels: [],     // {id,name,isDrum,gain,pan,mute,solo,plugins,pianoNotes,sampleBuffer,color}
  tracks: [],       // {id,channelId,clips:[{id,start,dur,buffer,offset,sampleName,startFrac}]}
  selectedChannelId: null,
  selectedClipId: null,
  recording: false,
  mediaRecorder: null,
  recChunks: [],
  recStream: null,
};
let chCounter = 0, trkCounter = 0, clipCounter = 0;

const TRACK_WIDTH_BEATS = 16; // плейлист = 16 долей
const COLOR_PALETTE = ['#3a5470','#4a6a3a','#6a4a4a','#5a4a6a','#6a6a3a','#3a6a6a'];
let colorIdx = 0;

/* ---------- DOM refs ---------- */
let $ = id => document.getElementById(id);

/* ============================================================
   INIT
   ============================================================ */
window.addEventListener('load', () => {
  initAudio();
  bindTransport();
  bindBrowser();
  bindChannelRack();
  bindPianoRoll();
  bindPlaylist();
  bindMixer();
  bindModal();

  // стартовые каналы
  addChannel('Kick', true);
  addChannel('Snare', true);
  addChannel('HiHat', true);
  addChannel('Bass', false);

  renderAll();
  requestAnimationFrame(meterLoop);
});

function renderAll(){
  renderSampleList();
  renderChannelRack();
  renderMixer();
  renderPlaylist();
  renderPianoRollChannelSelect();
  renderPianoRoll();
}

/* ============================================================
   TRANSPORT
   ============================================================ */
function bindTransport(){
  $('playBtn').onclick = () => { if(!isPlaying) startPlayback(); };
  $('stopBtn').onclick = () => stopPlayback();
  $('recBtn').onclick  = () => state.recording ? stopRecording() : startRecording();
  $('loopBtn').onclick = e => { isLooping = !isLooping; e.currentTarget.classList.toggle('active', isLooping); };
  $('loopBtn').classList.add('active');
  $('bpmInput').onchange = e => { bpm = clamp(parseInt(e.target.value)||120, 40, 300); e.target.value = bpm; };
  $('masterVol').oninput = e => { if(masterGain) masterGain.gain.value = +e.target.value; };
  $('exportBtn').onclick = exportWav;
}

function startPlayback(){
  initAudio();
  if(audioCtx.state==='suspended') audioCtx.resume();
  isPlaying = true;
  $('playBtn').classList.add('active');
  playStartTime = audioCtx.currentTime;
  nextNoteTime = playStartTime;
  currentBeat = 0;
  schedulerTimer = setInterval(scheduler, 25);
  scheduler();
  requestAnimationFrame(playheadLoop);
}

function stopPlayback(){
  isPlaying = false;
  $('playBtn').classList.remove('active');
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  activeSources.forEach(s => { try{ s.stop(); }catch(e){} });
  activeSources.clear();
  document.querySelectorAll('.playhead').forEach(p=>p.remove());
  $('positionDisplay').textContent = '1.1.1';
}

function scheduler(){
  if(!isPlaying) return;
  const stepDur = 60 / bpm / 4; // 16th notes
  while(nextNoteTime < audioCtx.currentTime + 0.1){
    scheduleStep(currentBeat, nextNoteTime);
    nextNoteTime += stepDur;
    currentBeat++;
    if(currentBeat >= TRACK_WIDTH_BEATS*4){
      if(isLooping) currentBeat = 0; else { stopPlayback(); return; }
    }
  }
}

function scheduleStep(step, time){
  const beat = step/4;

  // channel rack drums
  state.channels.forEach(ch => {
    if(!ch.sampleBuffer) return;
    if(ch.mute) return;
    if(state.channels.some(c=>c.solo) && !ch.solo) return;

    if(ch.isDrum){
      if(ch.pianoNotes.some(n => n.step === (step % 16))){
        playBuffer(ch.sampleBuffer, time, ch);
      }
    } else {
      // melodic: 16th resolution piano notes
      ch.pianoNotes.forEach(n => {
        if(n.step === step && n.note){
          playBufferPitched(ch.sampleBuffer, time, ch, midiToFreq(n.note));
        }
      });
    }
  });

  // playlist clips
  state.tracks.forEach(track => {
    const ch = state.channels.find(c=>c.id===track.channelId);
    if(!ch || ch.mute) return;
    if(state.channels.some(c=>c.solo) && !ch.solo) return;

    track.clips.forEach(clip => {
      const clipStartBeat = clip.start;
      const clipEndBeat = clip.start + clip.dur;
      // play if this beat falls inside clip
      if(beat + 1e-6 >= clipStartBeat && beat < clipEndBeat){
        const offsetInClip = (beat - clipStartBeat) * (60/bpm);
        // Only trigger at clip start OR every beat inside (for loops)
        const relBeat = beat - clipStartBeat;
        if(Math.abs(relBeat - Math.round(relBeat)) < 1e-6 || Math.abs(relBeat) < 1e-6){
          const buf = clip.buffer;
          const offsetSec = (offsetInClip % buf.duration);
          if(relBeat === 0 || Math.round(relBeat*4) % 4 === 0){
            playBufferAtOffset(buf, time, ch, offsetSec);
          }
        }
      }
    });
  });
}

function playheadLoop(){
  if(!isPlaying) return;
  const elapsed = audioCtx.currentTime - playStartTime;
  const beat = elapsed / (60/bpm);
  const bar = Math.floor(beat/4)+1;
  const b = Math.floor(beat%4)+1;
  const t = Math.floor((beat%1)*4)+1;
  $('positionDisplay').textContent = `${bar}.${b}.${t}`;

  // playhead in playlist
  const tracks = $('playlistTracks');
  if(tracks){
    document.querySelectorAll('.playhead').forEach(p=>p.remove());
    const totalBeats = TRACK_WIDTH_BEATS;
    const pct = (beat % totalBeats) / totalBeats * 100;
    state.tracks.forEach((_, i) => {
      const trackEl = tracks.children[i];
      if(!trackEl) return;
      const lane = trackEl.querySelector('.track-lane');
      if(!lane) return;
      const ph = document.createElement('div');
      ph.className = 'playhead';
      ph.style.left = pct + '%';
      lane.appendChild(ph);
    });
  }
  requestAnimationFrame(playheadLoop);
}

/* ============================================================
   AUDIO PLAYBACK (с плагинами)
   ============================================================ */
function playBuffer(buffer, time, ch){
  playBufferAtOffset(buffer, time, ch, 0, null);
}

function playBufferAtOffset(buffer, time, ch, offset=0, pitchRate=null){
  if(!buffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  if(pitchRate) src.playbackRate.value = pitchRate;
  buildPluginChain(src, ch).connect(masterGain);
  src.start(time, offset);
  activeSources.add(src);
  src.onended = () => activeSources.delete(src);
}

function playBufferPitched(buffer, time, ch, freq){
  if(!buffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  // Определяем базовую частоту через анализ? Нет — используем C4 (261.6) как базу
  // Простой подход: playbackRate = freq / 261.63
  src.playbackRate.value = clamp(freq/261.63, 0.25, 4);
  buildPluginChain(src, ch).connect(masterGain);
  src.start(time);
  activeSources.add(src);
  src.onended = () => activeSources.delete(src);
}

/**
 * Собирает цепочку плагинов для канала, возвращает последний узел.
 */
function buildPluginChain(src, ch){
  let node = src;

  // gain
  const g = audioCtx.createGain();
  g.gain.value = ch.gain;
  node.connect(g); node = g;

  // pan
  const p = audioCtx.createStereoPanner();
  p.pan.value = ch.pan;
  node.connect(p); node = p;

  // plugins
  ch.plugins.forEach(plugin => {
    if(!plugin) return;
    const pluginNode = buildPluginNode(plugin);
    if(pluginNode){
      node.connect(pluginNode.input);
      node = pluginNode.output;
    }
  });

  return node;
}

/**
 * Возвращает {input, output} для плагина.
 */
function buildPluginNode(plugin){
  const params = plugin.params;
  switch(plugin.type){

    case 'EQ': {
      const low = audioCtx.createBiquadFilter();
      low.type='lowshelf'; low.frequency.value=params.lowFreq; low.gain.value=params.lowGain;
      const mid = audioCtx.createBiquadFilter();
      mid.type='peaking'; mid.frequency.value=params.midFreq; mid.Q.value=1; mid.gain.value=params.midGain;
      const high = audioCtx.createBiquadFilter();
      high.type='highshelf'; high.frequency.value=params.highFreq; high.gain.value=params.highGain;
      low.connect(mid); mid.connect(high);
      return {input: low, output: high};
    }

    case 'Compressor': {
      const c = audioCtx.createDynamicsCompressor();
      c.threshold.value = params.threshold;
      c.ratio.value = params.ratio;
      c.attack.value = params.attack/1000;
      c.release.value = params.release/1000;
      return {input:c, output:c};
    }

    case 'Reverb': {
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const conv = audioCtx.createConvolver();
      conv.buffer = makeImpulse(params.decay, params.preDelay);
      const inp = audioCtx.createGain();
      inp.connect(dry);
      inp.connect(conv); conv.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Delay': {
      const inp = audioCtx.createGain();
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const dL = audioCtx.createDelay(2); dL.delayTime.value = params.time;
      const dR = audioCtx.createDelay(2); dR.delayTime.value = params.time;
      const fb = audioCtx.createGain(); fb.gain.value = params.feedback;
      const splitL = audioCtx.createStereoPanner(); splitL.pan.value=-1;
      const splitR = audioCtx.createStereoPanner(); splitR.pan.value=1;
      const merger = audioCtx.createChannelMerger(2);

      if(params.mode === 'ping-pong'){
        // ping-pong: L -> dR -> R -> dL -> L
        inp.connect(dry);
        inp.connect(dL);
        dL.connect(splitL); splitL.connect(dR);   // перекрёст
        dR.connect(splitR); splitR.connect(dL);
        dL.connect(merger, 0, 0);
        dR.connect(merger, 0, 1);
        merger.connect(wet);
        dL.connect(fb); fb.connect(dL);
      } else {
        inp.connect(dry);
        inp.connect(dL); inp.connect(dR);
        dL.connect(fb); fb.connect(dL);
        dR.connect(fb);
        dL.connect(wet); dR.connect(wet);
      }
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Chorus': {
      const inp = audioCtx.createGain();
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const delay = audioCtx.createDelay(0.1);
      delay.delayTime.value = 0.025;
      const lfo = audioCtx.createOscillator();
      lfo.frequency.value = params.rate;
      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.005 * params.depth;
      lfo.connect(lfoGain); lfoGain.connect(delay.delayTime);
      lfo.start();
      inp.connect(dry);
      inp.connect(delay); delay.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Flanger': {
      const inp = audioCtx.createGain();
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const delay = audioCtx.createDelay(0.05);
      delay.delayTime.value = 0.003;
      const lfo = audioCtx.createOscillator();
      lfo.frequency.value = params.rate;
      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.002 * params.depth;
      lfo.connect(lfoGain); lfoGain.connect(delay.delayTime);
      lfo.start();
      const fb = audioCtx.createGain();
      fb.gain.value = params.feedback;
      delay.connect(fb); fb.connect(delay);
      inp.connect(dry);
      inp.connect(delay); delay.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Distortion': {
      const ws = audioCtx.createWaveShaper();
      ws.curve = makeDistCurve(params.drive);
      ws.oversample='4x';
      const tone = audioCtx.createBiquadFilter();
      tone.type='lowpass'; tone.frequency.value = 400 + params.tone*8000;
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const inp = audioCtx.createGain();
      inp.connect(dry);
      inp.connect(ws); ws.connect(tone); tone.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Saturator': {
      const ws = audioCtx.createWaveShaper();
      ws.curve = makeSatCurve(params.drive);
      ws.oversample='2x';
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const inp = audioCtx.createGain();
      inp.connect(dry);
      inp.connect(ws); ws.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Bitcrusher': {
      // Простая реализация через скрипт-процессор невозможна без worklet.
      // Используем WaveShaper для квантования амплитуды + downsampling через gain
      const ws = audioCtx.createWaveShaper();
      ws.curve = makeBitCurve(params.bits);
      const dry = audioCtx.createGain(); dry.gain.value = 1-params.mix;
      const wet = audioCtx.createGain(); wet.gain.value = params.mix;
      const inp = audioCtx.createGain();
      inp.connect(dry);
      inp.connect(ws); ws.connect(wet);
      const out = audioCtx.createGain();
      dry.connect(out); wet.connect(out);
      return {input:inp, output:out};
    }

    case 'Deesser': {
      const hp = audioCtx.createBiquadFilter();
      hp.type='highpass'; hp.frequency.value = params.freq;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = params.threshold;
      comp.ratio.value = 4;
      comp.attack.value = 0.001;
      comp.release.value = 0.05;
      const inp = audioCtx.createGain();
      inp.connect(hp); hp.connect(comp);
      return {input:inp, output:comp};
    }

    case 'Ducker': {
      // Ducker: понижает громкость при превышении threshold
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = params.threshold;
      comp.ratio.value = params.ratio;
      comp.attack.value = params.attack/1000;
      comp.release.value = params.release/1000;
      return {input:comp, output:comp};
    }
  }
  return null;
}

/* ---------- DSP helpers ---------- */
function midiToFreq(m){ return 440 * Math.pow(2, (m-69)/12); }

function makeImpulse(decay, preDelay=0){
  const rate = audioCtx.sampleRate;
  const len = Math.max(rate*0.1, rate*decay);
  const pre = Math.floor(rate*preDelay);
  const buf = audioCtx.createBuffer(2, len, rate);
  for(let c=0;c<2;c++){
    const d = buf.getChannelData(c);
    for(let i=0;i<len;i++){
      if(i<pre) d[i]=0;
      else {
        const t = (i-pre)/rate;
        d[i] = (Math.random()*2-1) * Math.pow(1 - (i-pre)/len, 2);
      }
    }
  }
  return buf;
}

function makeDistCurve(drive){
  const n=1024, curve=new Float32Array(n);
  const k = drive*100 + 1;
  for(let i=0;i<n;i++){
    const x = (i*2)/n - 1;
    curve[i] = ((3+k)*x*20*Math.PI/180) / (Math.PI + k*Math.abs(x));
  }
  return curve;
}

function makeSatCurve(drive){
  const n=1024, curve=new Float32Array(n);
  const k = drive*10;
  for(let i=0;i<n;i++){
    const x = (i*2)/n - 1;
    curve[i] = Math.tanh(x * (1+k));
  }
  return curve;
}

function makeBitCurve(bits){
  const n=1024, curve=new Float32Array(n);
  const steps = Math.pow(2, Math.max(1,bits));
  for(let i=0;i<n;i++){
    const x = (i*2)/n - 1;
    curve[i] = Math.round(x*steps)/steps;
  }
  return curve;
}

/* ============================================================
   BROWSER / SAMPLES
   ============================================================ */
function bindBrowser(){
  const dz = $('dropZone');
  const fi = $('fileInput');
  dz.onclick = () => fi.click();
  fi.onchange = async e => {
    for(const f of e.target.files) await loadSampleFile(f);
    fi.value='';
  };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop = async e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    for(const f of e.dataTransfer.files){
      if(f.type.startsWith('audio/')) await loadSampleFile(f);
    }
  };
}

async function loadSampleFile(file){
  const ab = await file.arrayBuffer();
  const buffer = await audioCtx.decodeAudioData(ab);
  const name = file.name.replace(/\.[^.]+$/,'');
  let b = bpm;
  const m = name.match(/(\d{2,3})\s*bpm/i);
  if(m) b = parseInt(m[1]);
  state.samples.push({
    id: 'smp_'+Date.now()+Math.random(),
    name, buffer, bpm: b
  });
  renderSampleList();
}

function renderSampleList(){
  const el = $('sampleList');
  el.innerHTML = '';
  state.samples.forEach(s => {
    const d = document.createElement('div');
    d.className='sample-item';
    d.draggable = true;
    d.dataset.id = s.id;
    d.innerHTML = `${s.name}<span class="smp-bpm">${s.bpm} BPM</span>`;
    d.ondragstart = e => e.dataTransfer.setData('sample-id', s.id);
    d.onclick = () => {
      const ch = addChannel(s.name, false, s);
      state.selectedChannelId = ch.id;
      renderAll();
    };
    el.appendChild(d);
  });
}

/* ============================================================
   CHANNEL RACK
   ============================================================ */
function bindChannelRack(){
  $('addChannelBtn').onclick = () => addChannel('Channel '+(state.channels.length+1), false);
  $('channelList').onclick = e => {
    const item = e.target.closest('.channel-item');
    if(!item) return;
    const id = item.dataset.id;
    const ch = state.channels.find(c=>c.id===id);
    if(!ch) return;

    if(e.target.classList.contains('ch-btn')){
      const a = e.target.dataset.action;
      if(a==='mute'){ ch.mute=!ch.mute; e.target.classList.toggle('active', ch.mute); }
      else if(a==='solo'){ ch.solo=!ch.solo; e.target.classList.toggle('active', ch.solo); }
      else if(a==='del'){
        if(!confirm(`Удалить канал "${ch.name}"?`)) return;
        state.channels = state.channels.filter(c=>c.id!==id);
        state.tracks = state.tracks.filter(t=>t.channelId!==id);
        if(state.selectedChannelId===id) state.selectedChannelId=null;
        renderAll();
      }
      else if(a==='pr'){
        state.selectedChannelId = id;
        document.querySelector('[data-tab="pianoroll"]').click();
      }
      return;
    }
    state.selectedChannelId = id;
    renderChannelRack(); renderMixer(); renderPlaylist();
    renderPianoRollChannelSelect(); renderPianoRoll();
  };

  $('channelList').ondblclick = e => {
    const item = e.target.closest('.channel-item');
    if(!item) return;
    const ch = state.channels.find(c=>c.id===item.dataset.id);
    if(!ch) return;
    const name = prompt('Имя канала:', ch.name);
    if(name){ ch.name = name; renderAll(); }
  };

  // drop сэмпла на ченл-рек
  const list = $('channelList');
  list.ondragover = e => e.preventDefault();
  list.ondrop = e => {
    e.preventDefault();
    const sid = e.dataTransfer.getData('sample-id');
    const s = state.samples.find(x=>x.id===sid);
    if(s){
      const ch = addChannel(s.name, false, s);
      state.selectedChannelId = ch.id;
      renderAll();
    }
  };
}

function addChannel(name, isDrum, sample=null){
  const id = 'ch_'+(chCounter++);
  const ch = {
    id, name, isDrum,
    gain: 0.8, pan: 0,
    mute:false, solo:false,
    plugins: [],
    pianoNotes: [],
    sampleBuffer: sample ? sample.buffer : null,
    sampleBpm: sample ? sample.bpm : bpm,
    color: COLOR_PALETTE[colorIdx++ % COLOR_PALETTE.length]
  };
  if(isDrum && !sample){
    ch.sampleBuffer = makeDefaultDrum(name);
  }
  state.channels.push(ch);
  state.tracks.push({ id:'trk_'+(trkCounter++), channelId:id, clips:[] });
  if(!state.selectedChannelId) state.selectedChannelId = id;
  return ch;
}

function makeDefaultDrum(name){
  const dur = 0.3;
  const rate = audioCtx.sampleRate;
  const buf = audioCtx.createBuffer(1, rate*dur, rate);
  const d = buf.getChannelData(0);
  const n = name.toLowerCase();
  for(let i=0;i<d.length;i++){
    const t = i/rate;
    if(n.includes('kick')){
      d[i] = Math.sin(2*Math.PI*55*t) * Math.exp(-t*18);
    } else if(n.includes('snare')){
      d[i] = (Math.random()*2-1) * Math.exp(-t*22) * 0.8
           + Math.sin(2*Math.PI*180*t) * Math.exp(-t*20) * 0.4;
    } else if(n.includes('hat')){
      d[i] = (Math.random()*2-1) * Math.exp(-t*50) * 0.6;
    } else {
      d[i] = Math.sin(2*Math.PI*220*t) * Math.exp(-t*6) * 0.5;
    }
  }
  return buf;
}

function renderChannelRack(){
  const el = $('channelList');
  el.innerHTML='';
  state.channels.forEach(ch => {
    const d = document.createElement('div');
    d.className='channel-item' + (ch.id===state.selectedChannelId?' selected':'');
    d.dataset.id = ch.id;
    d.innerHTML = `
      <span class="ch-name">${escapeHtml(ch.name)}</span>
      <button class="ch-btn mute ${ch.mute?'active':''}" data-action="mute">M</button>
      <button class="ch-btn ${ch.solo?'active':''}" data-action="solo">S</button>
      <button class="ch-btn" data-action="pr" title="Piano roll">🎹</button>
      <button class="ch-btn del" data-action="del" title="Delete">✕</button>
    `;
    el.appendChild(d);
  });
}

/* ============================================================
   PIANO ROLL  (исправленная версия!)
   ============================================================ */
const PR = {
  canvas:null, ctx:null,
  keyWidth:60,
  keyHeight:14,
  numKeys:48,       // 4 октавы
  startNote:36,     // C2
  steps:32,         // 2 такта 16-х
  noteDrag:null,
  resizeDrag:null,
};

function bindPianoRoll(){
  PR.canvas = $('pianoRollCanvas');
  PR.ctx = PR.canvas.getContext('2d');

  $('prClear').onclick = () => {
    const ch = state.channels.find(c=>c.id===state.selectedChannelId);
    if(ch && confirm('Очистить ноты канала?')){ ch.pianoNotes=[]; renderPianoRoll(); }
  };

  PR.canvas.onmousedown = onPRMouseDown;
  PR.canvas.onmousemove = onPRMouseMove;
  window.addEventListener('mouseup', onPRMouseUp);
  PR.canvas.oncontextmenu = e => e.preventDefault();

  // клик по селекту
  $('prChannelSelect').onchange = e => {
    state.selectedChannelId = e.target.value;
    renderPianoRoll();
  };
}

function prGeometry(){
  const W = PR.canvas.width;
  const H = PR.canvas.height;
  const totalKeysH = PR.numKeys * PR.keyHeight;
  const stepW = (W - PR.keyWidth) / PR.steps;
  return {W, H, stepW, totalKeysH};
}

/**
 * Y -> MIDI note. Сверху высокие ноты.
 * row 0 = самый верх = самая высокая нота
 */
function yToNote(y){
  const row = Math.floor((y) / PR.keyHeight);
  if(row < 0 || row >= PR.numKeys) return null;
  // row 0 -> startNote + numKeys-1
  return PR.startNote + (PR.numKeys - 1 - row);
}
function noteToY(note){
  const row = PR.numKeys - 1 - (note - PR.startNote);
  return row * PR.keyHeight;
}
function xToStep(x){
  const {stepW} = prGeometry();
  const s = Math.floor((x - PR.keyWidth) / stepW);
  return clamp(s, 0, PR.steps-1);
}
function stepToX(step){
  const {stepW} = prGeometry();
  return PR.keyWidth + step*stepW;
}

function onPRMouseDown(e){
  const rect = PR.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if(x < PR.keyWidth) return; // клик по клавишам — просто превью

  const ch = state.channels.find(c=>c.id===state.selectedChannelId);
  if(!ch) return;

  const note = yToNote(y);
  if(note===null) return;

  if(e.button === 2){
    // ПКМ — удалить
    const step = xToStep(x);
    ch.pianoNotes = ch.pianoNotes.filter(n => !(n.note===note && n.step===step));
    renderPianoRoll();
    return;
  }

  // Проверяем — может кликнули по хвосту существующей ноты
  const existing = ch.pianoNotes.find(n => {
    if(n.note!==note) return false;
    const nx = stepToX(n.step);
    const {stepW} = prGeometry();
    const nw = stepW * (n.length||1);
    return x >= nx && x <= nx+nw;
  });

  if(existing){
    PR.resizeDrag = {noteObj: existing, startX: x};
    return;
  }

  // Добавляем ноту
  const step = xToStep(x);
  ch.pianoNotes.push({ note, step, length:1, velocity:0.8, active:true });

  // превью
  previewNote(ch, note);

  renderPianoRoll();
  PR.noteDrag = { note, step };
}

function onPRMouseMove(e){
  if(!PR.resizeDrag) return;
  const rect = PR.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const {stepW} = prGeometry();
  const n = PR.resizeDrag.noteObj;
  const newLen = Math.max(1, Math.round((x - stepToX(n.step)) / stepW));
  n.length = newLen;
  renderPianoRoll();
}

function onPRMouseUp(){
  PR.noteDrag=null;
  if(PR.resizeDrag){ PR.resizeDrag=null; renderPianoRoll(); }
}

function previewNote(ch, note){
  if(!ch.sampleBuffer) return;
  const t = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = ch.sampleBuffer;
  if(ch.isDrum){
    src.connect(masterGain);
  } else {
    src.playbackRate.value = clamp(midiToFreq(note)/261.63, 0.25, 4);
    const g = audioCtx.createGain(); g.gain.value = 0.7;
    src.connect(g); g.connect(masterGain);
  }
  src.start(t);
}

function renderPianoRollChannelSelect(){
  const sel = $('prChannelSelect');
  sel.innerHTML='';
  state.channels.forEach(ch => {
    const o = document.createElement('option');
    o.value = ch.id; o.textContent = ch.name;
    if(ch.id===state.selectedChannelId) o.selected=true;
    sel.appendChild(o);
  });
}

function renderPianoRoll(){
  if(!PR.ctx) return;
  const ctx = PR.ctx;
  const {W, H, stepW} = prGeometry();
  ctx.fillStyle='#0d0d0d'; ctx.fillRect(0,0,W,H);

  // grid vertical
  for(let i=0;i<=PR.steps;i++){
    const x = PR.keyWidth + i*stepW;
    ctx.strokeStyle = (i%4===0)?'#3a3a3a':'#1e1e1e';
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
  }
  // grid horizontal + keys
  for(let r=0;r<PR.numKeys;r++){
    const y = r*PR.keyHeight;
    const note = PR.startNote + (PR.numKeys-1-r);
    const isBlack = [1,3,6,8,10].includes(note%12);
    // key
    ctx.fillStyle = isBlack?'#151515':'#2a2a2a';
    ctx.fillRect(0,y,PR.keyWidth,PR.keyHeight);
    ctx.strokeStyle='#333';
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    // label
    if(note%12===0){
      ctx.fillStyle='#888';
      ctx.font='9px monospace';
      ctx.fillText('C'+(Math.floor(note/12)-1), 4, y+10);
    }
  }

  const ch = state.channels.find(c=>c.id===state.selectedChannelId);
  if(!ch) return;

  // notes
  ch.pianoNotes.forEach(n => {
    const x = stepToX(n.step);
    const w = stepW * (n.length||1);
    if(ch.isDrum){
      // для драм-каналов рисуем точки по центру (шаг 16)
      const cx = PR.keyWidth + ((n.step%16)+0.5) * (W-PR.keyWidth)/16;
      ctx.fillStyle='#e44';
      ctx.beginPath();
      ctx.arc(cx, H/2, 6, 0, Math.PI*2);
      ctx.fill();
    } else {
      const y = noteToY(n.note);
      ctx.fillStyle='#4a8a4a';
      ctx.fillRect(x, y+1, w-1, PR.keyHeight-2);
      ctx.strokeStyle='#7aca7a';
      ctx.strokeRect(x, y+1, w-1, PR.keyHeight-2);
    }
  });

  // help: если drum — рисуем сетку 16 шагов
  if(ch.isDrum){
    const lanes = 16;
    const lw = (W-PR.keyWidth)/lanes;
    for(let i=1;i<lanes;i++){
      const x = PR.keyWidth + i*lw;
      ctx.strokeStyle = (i%4===0)?'#444':'#222';
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    }
  }
}

/* ============================================================
   PLAYLIST
   ============================================================ */
function bindPlaylist(){
  $('addTrackBtn').onclick = () => {
    addChannel('Track '+(state.channels.length+1), false);
    renderAll();
  };

  const body = $('playlistTracks');
  body.ondragover = e => e.preventDefault();
  body.ondrop = async e => {
    e.preventDefault();
    const sid = e.dataTransfer.getData('sample-id');
    const clipId = e.dataTransfer.getData('clip-id');

    const lane = e.target.closest('.track-lane');
    if(!lane) return;

    const trackEl = lane.closest('.playlist-track');
    const trackId = trackEl?.dataset.id;
    const track = state.tracks.find(t=>t.id===trackId);
    if(!track) return;

    const rect = lane.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const beatWidth = rect.width / TRACK_WIDTH_BEATS;
    const startBeat = Math.max(0, Math.round(x/beatWidth));

    if(clipId){
      // перемещение клипа
      let moved=null;
      state.tracks.forEach(t=>{
        const i = t.clips.findIndex(c=>c.id===clipId);
        if(i>=0){ moved = t.clips.splice(i,1)[0]; }
      });
      if(moved){
        moved.start = startBeat;
        track.clips.push(moved);
        renderPlaylist();
      }
      return;
    }

    if(sid){
      const s = state.samples.find(x=>x.id===sid);
      if(!s) return;
      let buffer = s.buffer;
      let dur = (buffer.duration * bpm) / 60;
      // auto-bpm: если у сэмпла другой bpm — подстраиваем
      // (для простоты воспроизведения делаем через playbackRate при игре,
      //  а длину клипа считаем по новому bpm)
      const clip = {
        id: 'clip_'+(clipCounter++),
        start: startBeat,
        dur: dur,
        buffer: buffer,
        originalBpm: s.bpm,
        sampleName: s.name,
        offset: 0,
      };
      track.clips.push(clip);
      renderPlaylist();
    }
  };

  body.oncontextmenu = e => {
    const clipEl = e.target.closest('.clip');
    if(!clipEl) return;
    e.preventDefault();
    const id = clipEl.dataset.id;
    state.tracks.forEach(t=>{
      t.clips = t.clips.filter(c=>c.id!==id);
    });
    renderPlaylist();
  };

  body.onmousedown = e => {
    const clipEl = e.target.closest('.clip');
    if(!clipEl) return;
    state.selectedClipId = clipEl.dataset.id;
    if(e.target.classList.contains('clip-handle')){
      startResize(e, clipEl);
    }
    renderPlaylist();
  };
}

function startResize(e, clipEl){
  const startX = e.clientX;
  const startW = clipEl.offsetWidth;
  const clipId = clipEl.dataset.id;
  let clip = null;
  state.tracks.forEach(t=>{
    const c = t.clips.find(c=>c.id===clipId);
    if(c) clip = c;
  });
  if(!clip) return;
  const startDur = clip.dur;
  const laneEl = clipEl.parentElement;
  const beatW = laneEl.offsetWidth / TRACK_WIDTH_BEATS;

  function move(ev){
    const dx = ev.clientX - startX;
    const newW = Math.max(8, startW+dx);
    clipEl.style.width = newW+'px';
    clip.dur = Math.max(0.25, newW/beatW);
  }
  function up(){
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    renderPlaylist();
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function renderPlaylist(){
  // ruler
  const ruler = $('playlistRuler');
  ruler.innerHTML='';
  for(let i=0;i<TRACK_WIDTH_BEATS;i+=4){
    const m = document.createElement('div');
    m.className='bar-mark';
    m.style.left = (i/TRACK_WIDTH_BEATS*100)+'%';
    m.textContent = (i/4+1);
    ruler.appendChild(m);
  }

  const body = $('playlistTracks');
  body.innerHTML='';
  state.tracks.forEach(track => {
    const ch = state.channels.find(c=>c.id===track.channelId);
    if(!ch) return;
    const row = document.createElement('div');
    row.className='playlist-track';
    row.dataset.id = track.id;

    const head = document.createElement('div');
    head.className='track-header';
    head.innerHTML = `<span>${escapeHtml(ch.name)}</span>`;
    const del = document.createElement('button');
    del.className='del'; del.textContent='✕';
    del.onclick = () => {
      if(!confirm('Удалить дорожку?')) return;
      state.tracks = state.tracks.filter(t=>t.id!==track.id);
      renderPlaylist();
    };
    head.appendChild(del);
    row.appendChild(head);

    const lane = document.createElement('div');
    lane.className='track-lane';

    track.clips.forEach(clip => {
      const el = document.createElement('div');
      el.className = 'clip' + (clip.id===state.selectedClipId?' selected':'');
      el.dataset.id = clip.id;
      el.draggable = true;
      el.style.left = (clip.start/TRACK_WIDTH_BEATS*100)+'%';
      el.style.width = (clip.dur/TRACK_WIDTH_BEATS*100)+'%';
      el.textContent = clip.sampleName;
      el.ondragstart = e => e.dataTransfer.setData('clip-id', clip.id);
      const h = document.createElement('div');
      h.className='clip-handle';
      el.appendChild(h);
      lane.appendChild(el);
    });

    row.appendChild(lane);
    body.appendChild(row);
  });
}

/* ============================================================
   MIXER
   ============================================================ */
function bindMixer(){ /* рендер целиком */ }

function renderMixer(){
  const el = $('mixerStrips');
  el.innerHTML='';

  // Master
  el.appendChild(makeStrip('MASTER', null, true));

  state.channels.forEach(ch => el.appendChild(makeStrip(ch.name, ch, false)));
}

function makeStrip(name, ch, isMaster){
  const strip = document.createElement('div');
  strip.className='strip'+(isMaster?' master':'');

  const gain = ch ? ch.gain : masterGain.gain.value;

  strip.innerHTML = `
    <div class="strip-name">${escapeHtml(name)}</div>
    <div class="mini-meter"><div></div></div>
    <div class="strip-btns">
      ${!isMaster ? `<button class="mute ${ch.mute?'active':''}">M</button>
                    <button class="solo ${ch.solo?'active':''}">S</button>` : ''}
    </div>
    <div class="pan"></div>
    <div class="fader">
      <div class="fader-fill"></div>
      <div class="fader-handle"></div>
    </div>
    <div class="slots"></div>
  `;

  const fader = strip.querySelector('.fader');
  const handle = strip.querySelector('.fader-handle');
  const fill = strip.querySelector('.fader-fill');
  const panKnob = strip.querySelector('.pan');

  const setFader = v => {
    handle.style.bottom = (v*100)+'%';
    fill.style.height = (v*100)+'%';
  };
  setFader(gain);

  fader.onmousedown = e => {
    const rect = fader.getBoundingClientRect();
    function move(ev){
      const v = clamp(1 - (ev.clientY-rect.top)/rect.height, 0, 1);
      setFader(v);
      if(ch) ch.gain = v; else masterGain.gain.value = v;
    }
    function up(){
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  if(ch){
    let pan = ch.pan||0;
    const setPan = () => {
      panKnob.querySelector('::after');
      panKnob.style.setProperty('--rot', (pan*90)+'deg');
      panKnob.style.transform = `rotate(${pan*45}deg)`;
    };
    setPan();
    panKnob.onclick = () => {
      pan = pan >= 0.9 ? -1 : pan + 0.2;
      ch.pan = pan;
      panKnob.style.transform = `rotate(${pan*45}deg)`;
    };

    const mb = strip.querySelector('.mute');
    const sb = strip.querySelector('.solo');
    if(mb) mb.onclick = () => { ch.mute = !ch.mute; mb.classList.toggle('active', ch.mute); };
    if(sb) sb.onclick = () => { ch.solo = !ch.solo; sb.classList.toggle('active', ch.solo); };

    const slots = strip.querySelector('.slots');
    for(let i=0;i<3;i++){
      const s = document.createElement('div');
      const p = ch.plugins[i];
      s.className = 'slot'+(p?' filled':'');
      s.textContent = p ? p.name : '+';
      s.onclick = () => openPluginModal(ch, i);
      slots.appendChild(s);
    }
  }
  return strip;
}

/* ============================================================
   PLUGINS
   ============================================================ */
const PLUGIN_TYPES = ['EQ','Compressor','Reverb','Delay','Chorus','Flanger','Distortion','Saturator','Bitcrusher','Deesser','Ducker'];

function createPlugin(type){
  const p = { type, name:type, params:{} };
  switch(type){
    case 'EQ': p.params = { lowGain:0, midGain:0, highGain:0, lowFreq:200, midFreq:1000, highFreq:6000 }; break;
    case 'Compressor': p.params = { threshold:-20, ratio:4, attack:10, release:100 }; break;
    case 'Reverb': p.params = { mix:0.3, decay:2, preDelay:0.02 }; break;
    case 'Delay': p.params = { time:0.25, feedback:0.3, mix:0.3, mode:'normal' }; break;
    case 'Chorus': p.params = { rate:1.5, depth:0.5, mix:0.4 }; break;
    case 'Flanger': p.params = { rate:0.5, depth:0.7, feedback:0.5, mix:0.4 }; break;
    case 'Distortion': p.params = { drive:0.5, tone:0.5, mix:0.5 }; break;
    case 'Saturator': p.params = { drive:0.3, mix:0.5 }; break;
    case 'Bitcrusher': p.params = { bits:8, mix:0.5 }; break;
    case 'Deesser': p.params = { freq:6000, threshold:-20 }; break;
    case 'Ducker': p.params = { threshold:-30, ratio:4, attack:10, release:100 }; break;
  }
  return p;
}

function bindModal(){
  $('modalClose').onclick = () => $('pluginModal').classList.remove('show');
  $('pluginModal').onclick = e => { if(e.target.id==='pluginModal') $('pluginModal').classList.remove('show'); };
}

function openPluginModal(ch, slot){
  const modal = $('pluginModal');
  const ui = $('pluginUI');
  ui.innerHTML='';
  modal.classList.add('show');

  const existing = ch.plugins[slot];

  if(!existing){
    const h = document.createElement('h3');
    h.textContent='ADD PLUGIN';
    ui.appendChild(h);
    const sel = document.createElement('select');
    sel.size = 11;
    sel.style.height='auto';
    PLUGIN_TYPES.forEach(t => {
      const o = document.createElement('option');
      o.value=t; o.textContent=t;
      sel.appendChild(o);
    });
    ui.appendChild(sel);
    const btn = document.createElement('button');
    btn.className='plugin-add';
    btn.textContent='ADD';
    btn.onclick = () => {
      ch.plugins[slot] = createPlugin(sel.value);
      modal.classList.remove('show');
      renderMixer();
    };
    ui.appendChild(btn);
    return;
  }

  const h = document.createElement('h3');
  h.textContent = existing.name;
  ui.appendChild(h);

  const showParam = (key, label, min, max, step) => {
    const lbl = document.createElement('label');
    const v = existing.params[key];
    lbl.innerHTML = `<span>${label}</span><b>${fmt(v)}</b>`;
    ui.appendChild(lbl);
    const s = document.createElement('input');
    s.type='range'; s.min=min; s.max=max; s.step=step; s.value=v;
    s.oninput = () => {
      existing.params[key] = +s.value;
      lbl.querySelector('b').textContent = fmt(+s.value);
    };
    ui.appendChild(s);
  };

  const P = existing.params;
  switch(existing.type){
    case 'EQ':
      showParam('lowGain','Low Gain',-24,24,0.5);
      showParam('lowFreq','Low Freq',20,500,1);
      showParam('midGain','Mid Gain',-24,24,0.5);
      showParam('midFreq','Mid Freq',200,5000,10);
      showParam('highGain','High Gain',-24,24,0.5);
      showParam('highFreq','High Freq',2000,16000,100);
      break;
    case 'Compressor':
    case 'Ducker':
      showParam('threshold','Threshold',-60,0,1);
      showParam('ratio','Ratio',1,20,0.5);
      showParam('attack','Attack (ms)',0.1,100,0.1);
      showParam('release','Release (ms)',10,1000,10);
      break;
    case 'Reverb':
      showParam('mix','Mix',0,1,0.01);
      showParam('decay','Decay (s)',0.1,10,0.1);
      showParam('preDelay','Pre-Delay (s)',0,0.2,0.005);
      break;
    case 'Delay': {
      const l = document.createElement('label');
      l.innerHTML = '<span>Mode</span>';
      ui.appendChild(l);
      const sel = document.createElement('select');
      ['normal','ping-pong'].forEach(m=>{
        const o=document.createElement('option');
        o.value=m; o.textContent=m==='normal'?'Normal echo':'Ping-Pong';
        if(P.mode===m) o.selected=true;
        sel.appendChild(o);
      });
      sel.onchange = () => P.mode = sel.value;
      ui.appendChild(sel);
      showParam('time','Time (s)',0.01,2,0.01);
      showParam('feedback','Feedback',0,0.95,0.01);
      showParam('mix','Mix',0,1,0.01);
      break;
    }
    case 'Chorus':
      showParam('rate','Rate (Hz)',0.1,10,0.1);
      showParam('depth','Depth',0,1,0.01);
      showParam('mix','Mix',0,1,0.01);
      break;
    case 'Flanger':
      showParam('rate','Rate (Hz)',0.05,5,0.05);
      showParam('depth','Depth',0,1,0.01);
      showParam('feedback','Feedback',0,0.95,0.01);
      showParam('mix','Mix',0,1,0.01);
      break;
    case 'Distortion':
      showParam('drive','Drive',0,1,0.01);
      showParam('tone','Tone',0,1,0.01);
      showParam('mix','Mix',0,1,0.01);
      break;
    case 'Saturator':
      showParam('drive','Drive',0,1,0.01);
      showParam('mix','Mix',0,1,0.01);
      break;
    case 'Bitcrusher':
      showParam('bits','Bits',1,16,1);
      showParam('mix','Mix',0,1,0.01);
      break;
    case 'Deesser':
      showParam('freq','Freq',2000,12000,100);
      showParam('threshold','Threshold',-60,0,1);
      break;
  }

  const del = document.createElement('button');
  del.className='plugin-del';
  del.textContent='REMOVE PLUGIN';
  del.onclick = () => {
    ch.plugins.splice(slot,1);
    modal.classList.remove('show');
    renderMixer();
  };
  ui.appendChild(del);
}

function fmt(v){ return typeof v==='number' ? (Math.abs(v)>=10?v.toFixed(0):v.toFixed(2)) : v; }

/* ============================================================
   RECORDING
   ============================================================ */
async function startRecording(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    state.recStream = stream;
    state.mediaRecorder = new MediaRecorder(stream);
    state.recChunks = [];
    state.mediaRecorder.ondataavailable = e => { if(e.data.size) state.recChunks.push(e.data); };
    state.mediaRecorder.onstop = async () => {
      const blob = new Blob(state.recChunks, {type:'audio/webm'});
      const ab = await blob.arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(ab);
      const s = {
        id:'smp_'+Date.now(),
        name:'Vocal Take',
        buffer, bpm
      };
      state.samples.push(s);
      const ch = addChannel('Vocal', false, s);
      state.selectedChannelId = ch.id;

      const trk = state.tracks.find(t=>t.channelId===ch.id);
      if(trk){
        trk.clips.push({
          id:'clip_'+(clipCounter++),
          start: 0,
          dur: (buffer.duration * bpm)/60,
          buffer, originalBpm: bpm,
          sampleName:'Vocal Take', offset:0
        });
      }
      renderAll();
    };
    state.mediaRecorder.start();
    state.recording = true;
    $('recBtn').classList.add('active');
    $('recBtn').textContent='■';
  }catch(err){
    alert('Не удалось получить доступ к микрофону: '+err.message);
  }
}

function stopRecording(){
  if(state.mediaRecorder && state.mediaRecorder.state!=='inactive'){
    state.mediaRecorder.stop();
  }
  if(state.recStream){ state.recStream.getTracks().forEach(t=>t.stop()); }
  state.recording=false;
  $('recBtn').classList.remove('active');
  $('recBtn').textContent='●';
}

/* ============================================================
   EXPORT WAV (offline)
   ============================================================ */
async function exportWav(){
  if(isPlaying) stopPlayback();
  const duration = 60/bpm * TRACK_WIDTH_BEATS;
  const rate = audioCtx.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(rate*duration), rate);

  // master gain
  const mg = offline.createGain(); mg.gain.value = masterGain.gain.value;
  mg.connect(offline.destination);

  // для каждого канала собираем плагины в offline контексте (упрощённо: без плагинов, чтобы не усложнять)
  // Собираем все события
  const events = [];
  // playlist clips
  state.tracks.forEach(track=>{
    const ch = state.channels.find(c=>c.id===track.channelId);
    if(!ch || ch.mute) return;
    track.clips.forEach(clip=>{
      events.push({
        buffer: clip.buffer,
        when: (clip.start*60/bpm),
        gain: ch.gain,
        pan: ch.pan,
        offset: 0,
        playbackRate: clip.originalBpm && clip.originalBpm!==bpm ? bpm/clip.originalBpm : 1
      });
    });
  });
  // channel rack drums/melodies — 16 шагов в такте
  const stepDur = 60/bpm/4;
  const totalSteps = TRACK_WIDTH_BEATS*4;
  state.channels.forEach(ch=>{
    if(!ch.sampleBuffer || ch.mute) return;
    ch.pianoNotes.forEach(n=>{
      if(ch.isDrum){
        for(let s=n.step; s<totalSteps; s+=16){
          events.push({buffer:ch.sampleBuffer, when:s*stepDur, gain:ch.gain, pan:ch.pan, offset:0, playbackRate:1});
        }
      } else {
        events.push({
          buffer:ch.sampleBuffer, when:n.step*stepDur, gain:ch.gain, pan:ch.pan, offset:0,
          playbackRate: clamp(midiToFreq(n.note)/261.63, 0.25, 4)
        });
      }
    });
  });

  events.forEach(ev=>{
    const src = offline.createBufferSource();
    src.buffer = ev.buffer;
    src.playbackRate.value = ev.playbackRate;
    const g = offline.createGain(); g.gain.value = ev.gain;
    const p = offline.createStereoPanner(); p.pan.value = ev.pan;
    src.connect(g); g.connect(p); p.connect(mg);
    src.start(Math.max(0, ev.when), ev.offset);
  });

  const rendered = await offline.startRendering();
  const wav = bufferToWav(rendered);
  const blob = new Blob([wav], {type:'audio/wav'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'evo-mix.wav';
  a.click();
}

function bufferToWav(buffer){
  const numCh = buffer.numberOfChannels;
  const len = buffer.length * numCh * 2 + 44;
  const ab = new ArrayBuffer(len);
  const view = new DataView(ab);
  const ws = (o,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  let p=0;
  ws(p,'RIFF'); p+=4;
  view.setUint32(p, len-8, true); p+=4;
  ws(p,'WAVE'); p+=4;
  ws(p,'fmt '); p+=4;
  view.setUint32(p,16,true); p+=4;
  view.setUint16(p,1,true); p+=2;
  view.setUint16(p,numCh,true); p+=2;
  view.setUint32(p,buffer.sampleRate,true); p+=4;
  view.setUint32(p,buffer.sampleRate*numCh*2,true); p+=4;
  view.setUint16(p,numCh*2,true); p+=2;
  view.setUint16(p,16,true); p+=2;
  ws(p,'data'); p+=4;
  view.setUint32(p,buffer.length*numCh*2,true); p+=4;

  const chans = [];
  for(let c=0;c<numCh;c++) chans.push(buffer.getChannelData(c));
  for(let i=0;i<buffer.length;i++){
    for(let c=0;c<numCh;c++){
      const s = clamp(chans[c][i],-1,1);
      view.setInt16(p, s<0?s*0x8000:s*0x7FFF, true);
      p+=2;
    }
  }
  return ab;
}

/* ============================================================
   METER LOOP
   ============================================================ */
function meterLoop(){
  if(masterAnalyser){
    const arr = new Uint8Array(masterAnalyser.frequencyBinCount);
    masterAnalyser.getByteTimeDomainData(arr);
    let peak=0;
    for(let i=0;i<arr.length;i++){
      const v = Math.abs(arr[i]-128)/128;
      if(v>peak) peak=v;
    }
    const m = $('masterMeter');
    if(m) m.style.height = (peak*100)+'%';
  }
  requestAnimationFrame(meterLoop);
}

/* ============================================================
   UTILS
   ============================================================ */
function clamp(v,a,b){ return Math.min(b, Math.max(a, v)); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
