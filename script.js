// ========== АУДИО КОНТЕКСТ ==========
let audioCtx = null;
let masterGain = null;
let isPlaying = false;
let bpm = 120;
let startTime = 0;
let currentStep = 0;
let stepInterval = null;

function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(audioCtx.destination);
}

// ========== ГЛОБАЛЬНЫЕ ДАННЫЕ ==========
const state = {
    samples: [],        // {name, buffer, bpm}
    channels: [],       // {id, name, gain, pan, plugins[], pianoNotes[], isDrum, sampleBuffer}
    tracks: [],         // {id, channelId, clips: [{start, duration, buffer, sampleName, offset}]}
    selectedChannelId: null,
    selectedClip: null,
    isRecording: false,
    mediaRecorder: null,
    recordedChunks: [],
    recordChannelId: null
};

let channelIdCounter = 0;
let trackIdCounter = 0;

// ========== ИНИЦИАЛИЗАЦИЯ ==========
window.addEventListener('load', () => {
    initAudio();
    setupTransport();
    setupBrowser();
    setupChannelRack();
    setupPianoRoll();
    setupMixer();
    setupPlaylist();
    setupMasterVolume();
    setupRecording();

    // Добавляем тестовый канал
    addChannel('Kick', true);
    addChannel('Snare', true);
    addChannel('Hi-Hat', true);
    addChannel('Synth', false);

    renderAll();
});

function renderAll() {
    renderChannelRack();
    renderMixer();
    renderPlaylist();
}

// ========== ТРАНСПОРТ ==========
function setupTransport() {
    const playBtn = document.getElementById('playBtn');
    const stopBtn = document.getElementById('stopBtn');
    const recBtn = document.getElementById('recBtn');
    const bpmInput = document.getElementById('bpmInput');

    bpmInput.addEventListener('change', (e) => {
        bpm = parseInt(e.target.value) || 120;
        document.getElementById('bpmDisplay').textContent = bpm + ' BPM';
        if (isPlaying) { stopPlayback(); startPlayback(); }
    });

    playBtn.addEventListener('click', () => {
        if (isPlaying) return;
        initAudio();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        startPlayback();
    });

    stopBtn.addEventListener('click', stopPlayback);

    recBtn.addEventListener('click', () => {
        if (state.isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });
}

function startPlayback() {
    isPlaying = true;
    document.getElementById('playBtn').classList.add('active');
    startTime = audioCtx.currentTime;
    currentStep = 0;

    // Планировщик шагов (16-е ноты)
    const stepDuration = 60 / bpm / 4;
    let nextStepTime = startTime;

    function scheduleStep(step, time) {
        // Воспроизводим ноты из пиано-ролла и паттерны каналов
        state.channels.forEach(ch => {
            if (ch.isDrum && ch.pianoNotes) {
                // Drum-паттерн: точки на сетке
                ch.pianoNotes.forEach(note => {
                    if (note.step === step % 16 && note.active) {
                        playSample(ch.sampleBuffer, time, ch.gain, ch.pan, ch.plugins);
                    }
                });
            }
        });
    }

    function loop() {
        if (!isPlaying) return;
        const now = audioCtx.currentTime;
        while (nextStepTime < now + 0.1) {
            scheduleStep(currentStep, nextStepTime);
            nextStepTime += stepDuration;
            currentStep++;
        }
        requestAnimationFrame(loop);
    }
    loop();
}

function stopPlayback() {
    isPlaying = false;
    document.getElementById('playBtn').classList.remove('active');
}

// ========== БРАУЗЕР СЭМПЛОВ (DRAG & DROP) ==========
function setupBrowser() {
    const dropZone = document.getElementById('dropZone');
    const sampleList = document.getElementById('sampleList');

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        for (const file of files) {
            if (file.type.startsWith('audio/')) {
                await loadSampleFile(file);
            }
        }
    });

    // Клик по сэмплу — создаёт канал
    sampleList.addEventListener('click', (e) => {
        const item = e.target.closest('.sample-item');
        if (!item) return;
        const sample = state.samples.find(s => s.id === item.dataset.id);
        if (sample) {
            addChannel(sample.name, false, sample);
        }
    });

    // Drag сэмпла в плейлист/ченл-рек
    sampleList.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.sample-item');
        if (!item) return;
        e.dataTransfer.setData('text/plain', item.dataset.id);
        e.dataTransfer.effectAllowed = 'copy';
    });
}

async function loadSampleFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arrayBuffer);
    const name = file.name.replace(/\.[^.]+$/, '');

    // Определяем BPM (очень упрощённо — для лупов можно спросить у пользователя)
    let sampleBpm = bpm;
    const bpmMatch = name.match(/(\d{2,3})\s*bpm/i);
    if (bpmMatch) sampleBpm = parseInt(bpmMatch[1]);

    const sample = {
        id: 'smp_' + Date.now() + Math.random(),
        name: name,
        buffer: buffer,
        bpm: sampleBpm,
        originalBpm: sampleBpm
    };
    state.samples.push(sample);
    renderSampleList();
}

function renderSampleList() {
    const list = document.getElementById('sampleList');
    list.innerHTML = '';
    state.samples.forEach(s => {
        const div = document.createElement('div');
        div.className = 'sample-item';
        div.draggable = true;
        div.dataset.id = s.id;
        div.textContent = s.name + (s.bpm ? ` (${s.bpm} BPM)` : '');
        list.appendChild(div);
    });
}

// Авто-подстройка BPM под луп
function adjustBufferTempo(buffer, originalBpm, targetBpm) {
    if (!originalBpm || !targetBpm || originalBpm === targetBpm) return buffer;
    const ratio = targetBpm / originalBpm;
    const newLength = Math.ceil(buffer.length / ratio);
    const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, newLength, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = ratio;
    source.connect(offlineCtx.destination);
    source.start();
    return offlineCtx.startRendering();
}

// ========== CHANNEL RACK ==========
function setupChannelRack() {
    document.getElementById('addChannelBtn').addEventListener('click', () => {
        addChannel('Channel ' + (state.channels.length + 1), false);
    });

    document.getElementById('channelList').addEventListener('click', (e) => {
        const item = e.target.closest('.channel-item');
        if (!item) return;
        const chId = item.dataset.id;
        const ch = state.channels.find(c => c.id === chId);
        if (!ch) return;

        if (e.target.classList.contains('ch-btn')) {
            // Кнопка mute/solo/plugin
            if (e.target.dataset.action === 'mute') {
                ch.muted = !ch.muted;
                e.target.classList.toggle('active', ch.muted);
            } else if (e.target.dataset.action === 'solo') {
                ch.solo = !ch.solo;
                e.target.classList.toggle('active', ch.solo);
            }
        } else {
            // Выбор канала
            state.selectedChannelId = chId;
            renderChannelRack();
            renderMixer();
            renderPianoRollChannelSelect();
            renderPlaylist();
        }
    });
}

function addChannel(name, isDrum, sample = null) {
    const id = 'ch_' + (channelIdCounter++);
    const channel = {
        id: id,
        name: name,
        isDrum: isDrum,
        gain: 0.8,
        pan: 0,
        muted: false,
        solo: false,
        plugins: [],
        pianoNotes: [],   // {step, note, velocity, active}
        sampleBuffer: sample ? sample.buffer : null,
        sampleBpm: sample ? sample.bpm : bpm
    };
    state.channels.push(channel);

    // Создаём дорожку в плейлисте
    state.tracks.push({
        id: 'trk_' + (trackIdCounter++),
        channelId: id,
        clips: []
    });

    renderAll();
    return channel;
}

function renderChannelRack() {
    const list = document.getElementById('channelList');
    list.innerHTML = '';
    state.channels.forEach(ch => {
        const div = document.createElement('div');
        div.className = 'channel-item';
        div.dataset.id = ch.id;
        if (ch.id === state.selectedChannelId) div.style.borderColor = '#aaa';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'ch-name';
        nameSpan.textContent = ch.name;
        div.appendChild(nameSpan);

        const muteBtn = document.createElement('button');
        muteBtn.className = 'ch-btn' + (ch.muted ? ' active' : '');
        muteBtn.dataset.action = 'mute';
        muteBtn.textContent = 'M';
        div.appendChild(muteBtn);

        const soloBtn = document.createElement('button');
        soloBtn.className = 'ch-btn' + (ch.solo ? ' active' : '');
        soloBtn.dataset.action = 'solo';
        soloBtn.textContent = 'S';
        div.appendChild(soloBtn);

        // Кнопка пиано-ролла
        const prBtn = document.createElement('button');
        prBtn.className = 'ch-btn';
        prBtn.textContent = '🎹';
        prBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.selectedChannelId = ch.id;
            document.querySelector('[data-tab="pianoroll"]').click();
            renderPianoRollChannelSelect();
            renderPianoRoll();
        });
        div.appendChild(prBtn);

        list.appendChild(div);
    });
}

// ========== ПИАНО-РОЛЛ ==========
let pianoCanvas, pianoCtx;
const PIANO_KEY_HEIGHT = 16;
const PIANO_NUM_KEYS = 48; // 4 октавы
const PIANO_START_NOTE = 36; // C2

function setupPianoRoll() {
    pianoCanvas = document.getElementById('pianoRollCanvas');
    pianoCtx = pianoCanvas.getContext('2d');

    document.getElementById('prClear').addEventListener('click', () => {
        const ch = state.channels.find(c => c.id === state.selectedChannelId);
        if (ch) {
            ch.pianoNotes = [];
            renderPianoRoll();
        }
    });

    pianoCanvas.addEventListener('mousedown', (e) => {
        const rect = pianoCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const ch = state.channels.find(c => c.id === state.selectedChannelId);
        if (!ch) return;

        const step = Math.floor(x / (pianoCanvas.width / 32));
        const noteIndex = Math.floor(y / PIANO_KEY_HEIGHT);
        const note = PIANO_START_NOTE + (PIANO_NUM_KEYS - 1 - noteIndex);

        // Для drum-каналов используем step (точки), для мелодических — ноты
        if (ch.isDrum) {
            const existing = ch.pianoNotes.find(n => n.step === step);
            if (existing) {
                ch.pianoNotes = ch.pianoNotes.filter(n => n.step !== step);
            } else {
                ch.pianoNotes.push({ step: step, note: 60, active: true });
            }
        } else {
            ch.pianoNotes.push({ step: step, note: note, active: true });
        }

        // Воспроизводим превью
        if (ch.sampleBuffer) {
            playSample(ch.sampleBuffer, audioCtx.currentTime, ch.gain, ch.pan, ch.plugins);
        } else {
            playSynthNote(note, audioCtx.currentTime, 0.2);
        }

        renderPianoRoll();
    });

    window.addEventListener('resize', () => {
        if (document.getElementById('pianorollTab').classList.contains('active')) {
            renderPianoRoll();
        }
    });

    // Переключение табов
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab + 'Tab').classList.add('active');
            if (btn.dataset.tab === 'pianoroll') {
                renderPianoRollChannelSelect();
                renderPianoRoll();
            }
        });
    });
}

function renderPianoRollChannelSelect() {
    const sel = document.getElementById('prChannelSelect');
    sel.innerHTML = '';
    state.channels.forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = ch.name;
        if (ch.id === state.selectedChannelId) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.onchange = () => {
        state.selectedChannelId = sel.value;
        renderPianoRoll();
    };
}

function renderPianoRoll() {
    if (!pianoCtx) return;
    const canvas = pianoCanvas;
    const ctx = pianoCtx;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    // Сетка
    const stepWidth = w / 32;
    for (let i = 0; i <= 32; i++) {
        ctx.strokeStyle = i % 4 === 0 ? '#444' : '#2a2a2a';
        ctx.beginPath();
        ctx.moveTo(i * stepWidth, 0);
        ctx.lineTo(i * stepWidth, h);
        ctx.stroke();
    }

    // Клавиши
    for (let i = 0; i < PIANO_NUM_KEYS; i++) {
        const y = i * PIANO_KEY_HEIGHT;
        const note = PIANO_START_NOTE + (PIANO_NUM_KEYS - 1 - i);
        const isBlack = [1,3,6,8,10].includes(note % 12);
        ctx.fillStyle = isBlack ? '#222' : '#333';
        ctx.fillRect(0, y, 40, PIANO_KEY_HEIGHT);
        ctx.strokeStyle = '#444';
        ctx.strokeRect(0, y, 40, PIANO_KEY_HEIGHT);

        if (note % 12 === 0) {
            ctx.fillStyle = '#888';
            ctx.font = '9px monospace';
            ctx.fillText('C' + (Math.floor(note/12)-1), 2, y + 12);
        }
    }

    // Горизонтальные линии
    for (let i = 0; i <= PIANO_NUM_KEYS; i++) {
        ctx.strokeStyle = '#2a2a2a';
        ctx.beginPath();
        ctx.moveTo(0, i * PIANO_KEY_HEIGHT);
        ctx.lineTo(w, i * PIANO_KEY_HEIGHT);
        ctx.stroke();
    }

    // Ноты
    const ch = state.channels.find(c => c.id === state.selectedChannelId);
    if (ch && ch.pianoNotes) {
        ch.pianoNotes.forEach(n => {
            const x = n.step * stepWidth;
            if (ch.isDrum) {
                // Drum: точка
                ctx.fillStyle = '#e44';
                ctx.beginPath();
                ctx.arc(x + stepWidth/2, h/2, 6, 0, Math.PI*2);
                ctx.fill();
            } else {
                const noteIndex = PIANO_NUM_KEYS - 1 - (n.note - PIANO_START_NOTE);
                const y = noteIndex * PIANO_KEY_HEIGHT;
                ctx.fillStyle = '#4a8';
                ctx.fillRect(x, y, stepWidth - 1, PIANO_KEY_HEIGHT - 1);
            }
        });
    }
}

// ========== ПЛЕЙЛИСТ ==========
function setupPlaylist() {
    const tracksContainer = document.getElementById('playlistTracks');

    // Drag & drop сэмплов в плейлист
    tracksContainer.addEventListener('dragover', (e) => e.preventDefault());
    tracksContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        const sampleId = e.dataTransfer.getData('text/plain');
        if (!sampleId) return;

        const sample = state.samples.find(s => s.id === sampleId);
        if (!sample) return;

        const lane = e.target.closest('.track-lane');
        if (!lane) return;

        const trackEl = lane.closest('.playlist-track');
        const trackId = trackEl.dataset.id;
        const track = state.tracks.find(t => t.id === trackId);
        if (!track) return;

        // Вычисляем позицию клипа
        const rect = lane.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pixelsPerBeat = lane.offsetWidth / 16;
        const startBeat = Math.max(0, Math.round(x / pixelsPerBeat));

        // Подстраиваем BPM
        let buffer = sample.buffer;
        if (sample.bpm && sample.bpm !== bpm) {
            buffer = await adjustBufferTempo(sample.buffer, sample.bpm, bpm);
        }

        const durationBeats = (buffer.duration * bpm) / 60;

        track.clips.push({
            id: 'clip_' + Date.now() + Math.random(),
            start: startBeat,
            duration: durationBeats,
            buffer: buffer,
            sampleName: sample.name,
            offset: 0
        });

        renderPlaylist();
    });

    // Клики по клипам
    tracksContainer.addEventListener('mousedown', (e) => {
        const clipEl = e.target.closest('.clip');
        if (clipEl) {
            state.selectedClip = clipEl.dataset.id;
            renderPlaylist();
        }
    });

    // Drag клипов внутри плейлиста
    tracksContainer.addEventListener('dragstart', (e) => {
        const clipEl = e.target.closest('.clip');
        if (!clipEl) return;
        e.dataTransfer.setData('clip-id', clipEl.dataset.id);
    });
    tracksContainer.addEventListener('dragover', (e) => e.preventDefault());
    tracksContainer.addEventListener('drop', (e) => {
        const clipId = e.dataTransfer.getData('clip-id');
        if (!clipId) return;
        e.preventDefault();

        const lane = e.target.closest('.track-lane');
        if (!lane) return;
        const trackEl = lane.closest('.playlist-track');
        const trackId = trackEl.dataset.id;
        const track = state.tracks.find(t => t.id === trackId);
        if (!track) return;

        // Ищем клип во всех треках
        let movedClip = null;
        state.tracks.forEach(t => {
            const idx = t.clips.findIndex(c => c.id === clipId);
            if (idx !== -1) {
                movedClip = t.clips.splice(idx, 1)[0];
            }
        });
        if (!movedClip) return;

        const rect = lane.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pixelsPerBeat = lane.offsetWidth / 16;
        movedClip.start = Math.max(0, Math.round(x / pixelsPerBeat));
        track.clips.push(movedClip);
        renderPlaylist();
    });
}

function renderPlaylist() {
    const container = document.getElementById('playlistTracks');
    container.innerHTML = '';

    // Таймлайн
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        const marker = document.createElement('div');
        marker.className = 'bar-marker';
        marker.style.left = (i / 16 * 100) + '%';
        marker.textContent = i + 1;
        timeline.appendChild(marker);
    }

    state.tracks.forEach(track => {
        const ch = state.channels.find(c => c.id === track.channelId);
        const trackEl = document.createElement('div');
        trackEl.className = 'playlist-track';
        trackEl.dataset.id = track.id;

        const header = document.createElement('div');
        header.className = 'track-header';
        header.textContent = ch ? ch.name : 'Track';
        trackEl.appendChild(header);

        const lane = document.createElement('div');
        lane.className = 'track-lane';

        track.clips.forEach(clip => {
            const clipEl = document.createElement('div');
            clipEl.className = 'clip' + (clip.id === state.selectedClip ? ' selected' : '');
            clipEl.dataset.id = clip.id;
            clipEl.draggable = true;
            const pixelsPerBeat = lane.offsetWidth / 16 || 40;
            clipEl.style.left = (clip.start * pixelsPerBeat) + 'px';
            clipEl.style.width = (clip.duration * pixelsPerBeat) + 'px';
            clipEl.textContent = clip.sampleName;

            // Handle для обрезки
            const handle = document.createElement('div');
            handle.className = 'clip-handle';
            handle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                const startX = e.clientX;
                const origWidth = clipEl.offsetWidth;
                const origDuration = clip.duration;

                function onMove(ev) {
                    const dx = ev.clientX - startX;
                    const newWidth = Math.max(10, origWidth + dx);
                    const newDuration = origDuration * (newWidth / origWidth);
                    clipEl.style.width = newWidth + 'px';
                    clip.duration = newDuration;
                }
                function onUp() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    renderPlaylist();
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            clipEl.appendChild(handle);

            // Drag клипа
            clipEl.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('clip-id', clip.id);
            });

            lane.appendChild(clipEl);
        });

        trackEl.appendChild(lane);
        container.appendChild(trackEl);
    });
}

// ========== МИКШЕР ==========
function setupMixer() {
    // Ничего дополнительно, рендер в renderMixer
}

function renderMixer() {
    const container = document.getElementById('mixerStrips');
    container.innerHTML = '';

    // Master strip
    const masterStrip = createMixerStrip('Master', null, 0.8);
    container.appendChild(masterStrip);

    state.channels.forEach(ch => {
        const strip = createMixerStrip(ch.name, ch, ch.gain);
        container.appendChild(strip);
    });
}

function createMixerStrip(name, channel, gainValue) {
    const strip = document.createElement('div');
    strip.className = 'strip';

    const nameEl = document.createElement('div');
    nameEl.className = 'strip-name';
    nameEl.textContent = name;
    strip.appendChild(nameEl);

    // Pan
    const panKnob = document.createElement('div');
    panKnob.className = 'pan-knob';
    if (channel) {
        let pan = channel.pan || 0;
        panKnob.style.transform = `rotate(${pan * 90}deg)`;
        panKnob.addEventListener('click', () => {
            pan = pan >= 0.9 ? -1 : pan + 0.2;
            channel.pan = pan;
            renderMixer();
        });
    }
    strip.appendChild(panKnob);

    // Fader
    const fader = document.createElement('div');
    fader.className = 'fader';
    const handle = document.createElement('div');
    handle.className = 'fader-handle';
    handle.style.bottom = (gainValue * 100) + '%';
    fader.appendChild(handle);

    let currentGain = gainValue;
    fader.addEventListener('mousedown', (e) => {
        const rect = fader.getBoundingClientRect();
        function onMove(ev) {
            const y = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
            currentGain = y;
            handle.style.bottom = (y * 100) + '%';
            if (channel) channel.gain = y;
            else masterGain.gain.value = y;
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    strip.appendChild(fader);

    // Plugin slots
    const slots = document.createElement('div');
    slots.className = 'plugin-slots';
    if (channel) {
        for (let i = 0; i < 3; i++) {
            const slot = document.createElement('div');
            slot.className = 'plugin-slot';
            const plugin = channel.plugins[i];
            slot.textContent = plugin ? plugin.name : '+';
            slot.addEventListener('click', () => {
                openPluginModal(channel, i);
            });
            slots.appendChild(slot);
        }
    }
    strip.appendChild(slots);

    return strip;
}

// ========== ПЛАГИНЫ ==========
const PLUGIN_TYPES = [
    'EQ', 'Compressor', 'Reverb', 'Delay', 'Chorus',
    'Flanger', 'Distortion', 'Saturator', 'Bitcrusher', 'Deesser', 'Ducker'
];

function openPluginModal(channel, slotIndex) {
    const modal = document.getElementById('pluginModal');
    const ui = document.getElementById('pluginUI');
    modal.classList.add('show');

    const existing = channel.plugins[slotIndex];

    ui.innerHTML = '';

    if (!existing) {
        // Выбор плагина
        const select = document.createElement('select');
        PLUGIN_TYPES.forEach(pt => {
            const opt = document.createElement('option');
            opt.value = pt;
            opt.textContent = pt;
            select.appendChild(opt);
        });
        ui.appendChild(select);

        const btn = document.createElement('button');
        btn.textContent = 'Добавить';
        btn.style.marginTop = '10px';
        btn.addEventListener('click', () => {
            const plugin = createPlugin(select.value);
            channel.plugins[slotIndex] = plugin;
            closeModal();
            renderMixer();
        });
        ui.appendChild(btn);
    } else {
        renderPluginParams(existing, ui, () => {
            renderMixer();
        });
    }

    modal.querySelector('.close').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function closeModal() {
    document.getElementById('pluginModal').classList.remove('show');
}

function createPlugin(type) {
    const plugin = { name: type, type: type, params: {} };
    switch(type) {
        case 'EQ':
            plugin.params = { lowGain: 0, midGain: 0, highGain: 0, lowFreq: 200, midFreq: 1000, highFreq: 6000 };
            break;
        case 'Compressor':
            plugin.params = { threshold: -20, ratio: 4, attack: 10, release: 100 };
            break;
        case 'Reverb':
            plugin.params = { mix: 0.3, decay: 2, preDelay: 0.02 };
            break;
        case 'Delay':
            plugin.params = { time: 0.25, feedback: 0.3, mix: 0.3, mode: 'normal' };
            break;
        case 'Chorus':
            plugin.params = { rate: 1.5, depth: 0.5, mix: 0.4 };
            break;
        case 'Flanger':
            plugin.params = { rate: 0.5, depth: 0.7, feedback: 0.5, mix: 0.4 };
            break;
        case 'Distortion':
            plugin.params = { drive: 0.5, tone: 0.5, mix: 0.5 };
            break;
        case 'Saturator':
            plugin.params = { drive: 0.3, mix: 0.5 };
            break;
        case 'Bitcrusher':
            plugin.params = { bits: 8, rate: 0.5, mix: 0.5 };
            break;
        case 'Deesser':
            plugin.params = { freq: 6000, threshold: -20, amount: 0.5 };
            break;
        case 'Ducker':
            plugin.params = { threshold: -30, ratio: 4, attack: 10, release: 100 };
            break;
    }
    return plugin;
}

function renderPluginParams(plugin, container, onChange) {
    const title = document.createElement('h3');
    title.textContent = plugin.name;
    title.style.marginBottom = '10px';
    container.appendChild(title);

    // Режим Delay
    if (plugin.type === 'Delay') {
        const modeLabel = document.createElement('label');
        modeLabel.textContent = 'Режим';
        container.appendChild(modeLabel);
        const modeSelect = document.createElement('select');
        ['normal', 'ping-pong'].forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m === 'normal' ? 'Обычное эхо' : 'Ping-Pong';
            if (plugin.params.mode === m) opt.selected = true;
            modeSelect.appendChild(opt);
        });
        modeSelect.addEventListener('change', () => {
            plugin.params.mode = modeSelect.value;
            onChange();
        });
        container.appendChild(modeSelect);
    }

    Object.keys(plugin.params).forEach(param => {
        if (param === 'mode') return;
        const label = document.createElement('label');
        label.textContent = param + ': ' + (typeof plugin.params[param] === 'number' ? plugin.params[param].toFixed(2) : plugin.params[param]);
        container.appendChild(label);

        const slider = document.createElement('input');
        slider.type = 'range';
        let min = 0, max = 1, step = 0.01;
        switch(param) {
            case 'threshold': min = -60; max = 0; step = 1; break;
            case 'ratio': min = 1; max = 20; step = 0.5; break;
            case 'attack': min = 0.1; max = 100; step = 1; break;
            case 'release': min = 10; max = 1000; step = 10; break;
            case 'lowFreq': min = 20; max = 500; step = 10; break;
            case 'midFreq': min = 200; max = 5000; step = 50; break;
            case 'highFreq': min = 2000; max = 16000; step = 100; break;
            case 'bits': min = 1; max = 16; step = 1; break;
            case 'freq': min = 2000; max = 12000; step = 100; break;
            case 'decay': min = 0.1; max = 10; step = 0.1; break;
            case 'time': min = 0.01; max = 2; step = 0.01; break;
            case 'rate': min = 0.1; max = 10; step = 0.1; break;
            case 'drive': case 'depth': case 'mix': case 'feedback': case 'amount': min = 0; max = 1; step = 0.01; break;
            case 'preDelay': min = 0; max = 0.2; step = 0.001; break;
        }
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = plugin.params[param];
        slider.addEventListener('input', () => {
            plugin.params[param] = parseFloat(slider.value);
            label.textContent = param + ': ' + parseFloat(slider.value).toFixed(2);
            onChange();
        });
        container.appendChild(slider);
    });

    // Удаление плагина
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Удалить плагин';
    delBtn.style.marginTop = '10px';
    delBtn.addEventListener('click', () => {
        // Находим канал и слот
        state.channels.forEach(ch => {
            const idx = ch.plugins.indexOf(plugin);
            if (idx !== -1) ch.plugins.splice(idx, 1);
        });
        closeModal();
        renderMixer();
    });
    container.appendChild(delBtn);
}

// ========== ВОСПРОИЗВЕДЕНИЕ ЗВУКА С ПЛАГИНАМИ ==========
function playSample(buffer, time, gainVal, pan, plugins) {
    if (!buffer) return;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;

    let node = source;
    let gainNode = audioCtx.createGain();
    gainNode.gain.value = gainVal;

    let panNode = audioCtx.createStereoPanner();
    panNode.pan.value = pan;

    // Применяем плагины (упрощённо)
    let delayNode = null;
    if (plugins) {
        plugins.forEach(plugin => {
            if (!plugin) return;
            switch(plugin.type) {
                case 'EQ':
                    // Простой 3-полосный EQ
                    const low = audioCtx.createBiquadFilter();
                    low.type = 'lowshelf';
                    low.frequency.value = plugin.params.lowFreq;
                    low.gain.value = plugin.params.lowGain;
                    node.connect(low);
                    node = low;

                    const mid = audioCtx.createBiquadFilter();
                    mid.type = 'peaking';
                    mid.frequency.value = plugin.params.midFreq;
                    mid.gain.value = plugin.params.midGain;
                    node.connect(mid);
                    node = mid;

                    const high = audioCtx.createBiquadFilter();
                    high.type = 'highshelf';
                    high.frequency.value = plugin.params.highFreq;
                    high.gain.value = plugin.params.highGain;
                    node.connect(high);
                    node = high;
                    break;
                case 'Compressor':
                    const comp = audioCtx.createDynamicsCompressor();
                    comp.threshold.value = plugin.params.threshold;
                    comp.ratio.value = plugin.params.ratio;
                    comp.attack.value = plugin.params.attack / 1000;
                    comp.release.value = plugin.params.release / 1000;
                    node.connect(comp);
                    node = comp;
                    break;
                case 'Reverb':
                    const convolver = audioCtx.createConvolver();
                    // Генерируем импульсный отклик
                    const rate = audioCtx.sampleRate;
                    const length = rate * plugin.params.decay;
                    const impulse = audioCtx.createBuffer(2, length, rate);
                    for (let ch = 0; ch < 2; ch++) {
                        const data = impulse.getChannelData(ch);
                        for (let i = 0; i < length; i++) {
                            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
                        }
                    }
                    convolver.buffer = impulse;
                    const wetGain = audioCtx.createGain();
                    wetGain.gain.value = plugin.params.mix;
                    const dryGain = audioCtx.createGain();
                    dryGain.gain.value = 1 - plugin.params.mix;
                    node.connect(dryGain);
                    dryGain.connect(gainNode);
                    node.connect(convolver);
                    convolver.connect(wetGain);
                    wetGain.connect(gainNode);
                    node = gainNode;
                    break;
                case 'Delay':
                    const delay = audioCtx.createDelay(2);
                    delay.delayTime.value = plugin.params.time;
                    const fb = audioCtx.createGain();
                    fb.gain.value = plugin.params.feedback;
                    const delayMix = audioCtx.createGain();
                    delayMix.gain.value = plugin.params.mix;
                    delay.connect(fb);
                    fb.connect(delay);
                    node.connect(delay);
                    delay.connect(delayMix);
                    delayMix.connect(gainNode);
                    node = gainNode;
                    break;
                case 'Distortion':
                    const dist = audioCtx.createWaveShaper();
                    const k = plugin.params.drive * 100;
                    const n = 44100;
                    const curve = new Float32Array(n);
                    for (let i = 0; i < n; i++) {
                        const x = (i * 2) / n - 1;
                        curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
                    }
                    dist.curve = curve;
                    dist.oversample = '4x';
                    node.connect(dist);
                    node = dist;
                    break;
                case 'Bitcrusher':
                    const crusher = audioCtx.createWaveShaper();
                    const bits = plugin.params.bits;
                    const steps = Math.pow(2, bits);
                    const curve2 = new Float32Array(1024);
                    for (let i = 0; i < 1024; i++) {
                        const x = (i / 1024) * 2 - 1;
                        curve2[i] = Math.round(x * steps) / steps;
                    }
                    crusher.curve = curve2;
                    node.connect(crusher);
                    node = crusher;
                    break;
                // Chorus, Flanger, Saturator, Deesser, Ducker — упрощённо пропускаем
            }
        });
    }

    node.connect(panNode);
    panNode.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(time);
}

function playSynthNote(note, time, duration) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(time);
    osc.stop(time + duration);
}

// ========== МАСТЕР-ГРОМКОСТЬ ==========
function setupMasterVolume() {
    document.getElementById('masterVol').addEventListener('input', (e) => {
        if (masterGain) masterGain.gain.value = parseFloat(e.target.value);
    });
}

// ========== ЗАПИСЬ ВОКАЛА ==========
function setupRecording() {
    document.getElementById('recBtn').addEventListener('click', async () => {
        if (!state.isRecording) {
            startRecording();
        } else {
            stopRecording();
        }
    });
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.mediaRecorder = new MediaRecorder(stream);
        state.recordedChunks = [];

        state.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) state.recordedChunks.push(e.data);
        };

        state.mediaRecorder.onstop = async () => {
            const blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
            const arrayBuffer = await blob.arrayBuffer();
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);

            // Создаём сэмпл
            const sample = {
                id: 'smp_' + Date.now(),
                name: 'Vocal Take',
                buffer: buffer,
                bpm: bpm,
                originalBpm: bpm
            };
            state.samples.push(sample);
            renderSampleList();

            // Автоматически создаём канал с этим сэмплом
            const ch = addChannel('Vocal', false, sample);
            state.selectedChannelId = ch.id;

            // Добавляем клип в плейлист на текущую позицию
            const track = state.tracks.find(t => t.channelId === ch.id);
            if (track) {
                track.clips.push({
                    id: 'clip_' + Date.now(),
                    start: 0,
                    duration: (buffer.duration * bpm) / 60,
                    buffer: buffer,
                    sampleName: 'Vocal Take',
                    offset: 0
                });
            }
            renderPlaylist();
        };

        state.mediaRecorder.start();
        state.isRecording = true;
        document.getElementById('recBtn').classList.add('active');
        document.getElementById('recBtn').textContent = '■';
    } catch (err) {
        alert('Не удалось получить доступ к микрофону: ' + err.message);
    }
}

function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
        state.mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    state.isRecording = false;
    document.getElementById('recBtn').classList.remove('active');
    document.getElementById('recBtn').textContent = '●';
}

// ========== ИНИЦИАЛИЗАЦИЯ ПРИ ЗАГРУЗКЕ ==========
// Переопределяем добавление канала для drum-каналов (создаём пустой буфер)
const originalAddChannel = addChannel;
addChannel = function(name, isDrum, sample) {
    const ch = originalAddChannel(name, isDrum, sample);
    if (isDrum && !sample) {
        // Создаём простой синтезированный звук для драм-канала
        const duration = 0.2;
        const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            const t = i / audioCtx.sampleRate;
            data[i] = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 20);
        }
        ch.sampleBuffer = buffer;
    }
    return ch;
};
