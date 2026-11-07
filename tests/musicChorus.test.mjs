import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/musicChorus.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { getMusicChorus, chorusRange } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('chorus timestamps become seconds and are clipped to the actual audio duration', () => {
  const chorus = { startTime: 47500, endTime: 88500 };
  assert.deepEqual(chorusRange(chorus, 180), { start: 47.5, end: 88.5 });
  assert.deepEqual(chorusRange(chorus, 60), { start: 47.5, end: 60 });
  for (const duration of [0, 30, 47.5, NaN, Infinity]) {
    assert.equal(chorusRange(chorus, duration), null);
  }
  assert.equal(chorusRange(null, 180), null);
});

test('concurrent requests for a song share the result', async () => {
  let calls = 0;
  const chorus = { startTime: 40000, endTime: 113500 };
  const request = async () => { calls++; return chorus; };
  const results = await Promise.all([getMusicChorus('185163', request), getMusicChorus('185163', request)]);
  assert.deepEqual(results, [chorus, chorus]);
  assert.equal(await getMusicChorus('185163', request), chorus);
  assert.equal(calls, 1);
});

test('imported paths never reach the music API', async () => {
  const request = () => { throw Error('unexpected network request'); };
  assert.equal(await getMusicChorus('C:/Music/song.mp3', request), null);
  assert.equal(await getMusicChorus('', request), null);
});

test('missing and invalid chorus metadata fall back to normal playback', async () => {
  const values = [null, { startTime: -1, endTime: 1000 }, { startTime: 1000, endTime: 1000 },
    { startTime: NaN, endTime: 1000 }, { startTime: 0, endTime: Infinity }];
  for (const [index, value] of values.entries()) {
    assert.equal(await getMusicChorus(String(900000 + index), async () => value), null);
  }
});

test('a temporary API failure allows a later retry', async () => {
  assert.equal(await getMusicChorus('33894312', async () => { throw Error('timeout'); }), null);
  const chorus = { startTime: 47500, endTime: 88500 };
  assert.deepEqual(await getMusicChorus('33894312', async () => chorus), chorus);
});

test('songs without chorus metadata are cached too', async () => {
  let calls = 0;
  const request = async () => { calls++; return null; };
  assert.equal(await getMusicChorus('910000', request), null);
  assert.equal(await getMusicChorus('910000', request), null);
  assert.equal(calls, 1);
});

test('cache pressure evicts the least recently used song without clearing other songs', async () => {
  const calls = new Map();
  const request = async id => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return { startTime: 10000, endTime: 20000 };
  };
  for (let index = 0; index < 128; index++) {
    await getMusicChorus(String(920000 + index), request);
  }
  await getMusicChorus('920000', request);
  await getMusicChorus('920128', request);
  await getMusicChorus('920000', request);
  await getMusicChorus('920127', request);
  assert.equal(calls.get('920000'), 1);
  assert.equal(calls.get('920127'), 1);
  await getMusicChorus('920001', request);
  assert.equal(calls.get('920001'), 2);
});

const editor = fs.readFileSync(new URL('../src/components/music/MusicEditor.tsx', import.meta.url), 'utf8');
const playback = ts.transpileModule(editor.slice(editor.indexOf('  const playTrack ='), editor.indexOf('  const playNext =')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function playerHarness(options = {}) {
  const state = { chorus: null, position: 0, playing: false };
  const media = {
    src: '', currentTime: 0, duration: options.duration ?? 180, paused: true,
    pause() { this.paused = true; },
    removeAttribute() { this.src = ''; },
    load() { this.currentTime = 0; },
    async play() {
      if (!this.metadataLoaded) {
        handlers.handleLoadedMetadata({ currentTarget: this });
        this.metadataLoaded = true;
      }
      this.paused = false;
    },
    set src(value) { this.url = value; this.metadataLoaded = false; },
    get src() { return this.url; },
  };
  const bindings = {
    audio: { current: media }, playbackRequest: { current: 0 }, pendingChorusStart: { current: null },
    tab: 'online', queueTracks: [], queueSearchTerm: { current: '' }, searchTerm: '',
    localTracks: options.localTracks ?? [], current: {}, chorusRange,
    convertFileSrc: path => `asset:${path}`,
    resolveGDStudioPlayUrl: async id => `https://example.com/${id}.mp3`,
    musicApi: { chorus: options.chorus ?? (async () => ({ startTime: 47500, endTime: 88500 })) },
    setQueueTracks() {}, setQueueSource() {}, setSelection() {}, setCurrent() {}, setDuration() {},
    setError(value) { state.error = value; },
    setChorus(value) { state.chorus = value; },
    setPosition(value) { state.position = value; },
    setPlaying(value) { state.playing = value; },
  };
  const handlers = new Function(...Object.keys(bindings), `${playback}\nreturn { playTrack, handleLoadedMetadata, togglePlayback };`)(...Object.values(bindings));
  return { ...handlers, media, state };
}

const song = { id: '33894312', duration: 180000, path: null };

test('search playback starts at the chorus and resume keeps the chosen position', async () => {
  const player = playerHarness();
  await player.playTrack(song, [song], 'online');
  assert.equal(player.media.currentTime, 47.5);
  assert.equal(player.state.position, 47.5);
  player.media.currentTime = 72;
  await player.togglePlayback();
  assert.equal(player.media.paused, true);
  await player.togglePlayback();
  assert.equal(player.media.currentTime, 72);
});

test('local playback, missing metadata and short previews start at zero', async () => {
  for (const [options, source] of [[{}, 'local'], [{ chorus: async () => null }, 'online'], [{ duration: 30 }, 'online']]) {
    const player = playerHarness(options);
    await player.playTrack(song, [song], source);
    assert.equal(player.media.currentTime, 0);
    assert.equal(player.media.paused, false);
  }
});

test('local audio starts without requesting chorus metadata from any library', async () => {
  let requests = 0;
  const saved = { ...song, path: 'C:/Music/song.mp3' };
  for (const source of ['local', 'online', 'playlist:example']) {
    for (const direct of [false, true]) {
      const player = playerHarness({
        localTracks: direct ? [] : [saved],
        chorus: () => { requests++; return new Promise(() => {}); },
      });
      await player.playTrack(direct ? saved : song, [song], source);
      assert.equal(player.media.src, 'asset:C:/Music/song.mp3');
      assert.equal(player.media.currentTime, 0);
      assert.equal(player.media.paused, false);
      assert.equal(player.state.chorus, null);
    }
  }
  assert.equal(requests, 0);
});

test('a slow chorus response from an earlier song cannot replace the current song', async () => {
  let resolveFirst;
  const player = playerHarness({ chorus: id => id === song.id
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ startTime: 10000, endTime: 20000 }) });
  const first = player.playTrack(song, [song], 'online');
  const next = { ...song, id: '185163' };
  await player.playTrack(next, [next], 'online');
  resolveFirst({ startTime: 47500, endTime: 88500 });
  await first;
  assert.equal(player.media.src, 'https://example.com/185163.mp3');
  assert.equal(player.media.currentTime, 10);
  assert.equal(player.state.chorus.startTime, 10000);
});

const seekHandlers = ts.transpileModule(editor.slice(editor.indexOf('  const seekTo ='), editor.indexOf('  const togglePlayback =')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function seekHarness(chorus, duration, width = 408) {
  const audio = { current: { currentTime: 5 } };
  const pendingChorusStart = { current: chorus };
  let position = 5;
  const bindings = { chorus, duration, chorusRange, audio, pendingChorusStart, setPosition(value) { position = value; } };
  const handler = new Function(...Object.keys(bindings), `${seekHandlers}\nreturn handleProgressPointerUp;`)(...Object.values(bindings));
  return {
    audio, pendingChorusStart,
    get position() { return position; },
    release(clientX, overrides = {}) {
      handler({ isPrimary: true, button: 0, clientX,
        currentTarget: { getBoundingClientRect: () => ({ left: 100, width }) }, ...overrides });
    },
  };
}

test('clicking either side near the chorus start snaps to its exact timestamp', () => {
  const chorus = { startTime: 47500, endTime: 88500 };
  for (const [duration, width] of [[180, 408], [360, 208], [60, 808]]) {
    const startX = 104 + (width - 8) * 47.5 / duration;
    for (const distance of [-12, -5, 0, 5, 12]) {
      const player = seekHarness(chorus, duration, width);
      player.release(startX + distance);
      assert.equal(player.audio.current.currentTime, 47.5);
      assert.equal(player.position, 47.5);
      assert.equal(player.pendingChorusStart.current, null);
    }
    const player = seekHarness(chorus, duration, width);
    player.release(startX + 13);
    assert.equal(player.audio.current.currentTime, 5);
  }
});

test('missing chorus, short previews and secondary pointers do not snap', () => {
  const chorus = { startTime: 47500, endTime: 88500 };
  for (const [metadata, duration, overrides] of [[null, 180, {}], [chorus, 30, {}],
    [chorus, 180, { button: 2 }], [chorus, 180, { isPrimary: false }]]) {
    const player = seekHarness(metadata, duration);
    player.release(104 + 400 * 47.5 / duration, overrides);
    assert.equal(player.audio.current.currentTime, 5);
  }
});
