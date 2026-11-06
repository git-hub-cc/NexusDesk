import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/musicPlaylist.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { rememberPlaylistTracks, resolvePlaylistTracks, removePlaylistTrack } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const track = { id: '123', title: '原歌曲名称', artist: '歌手', album: '专辑', duration: 120000, path: 'song.mp3', coverPath: 'song.jpg' };

test('legacy playlists retain song details after deleting local files and reloading', () => {
  const playlists = rememberPlaylistTracks([{ id: 'a', name: '歌单', trackIds: [track.id] }], [track]);
  const reloaded = JSON.parse(JSON.stringify(playlists));
  const [missing] = resolvePlaylistTracks(reloaded[0], []);
  assert.equal(missing.title, track.title);
  assert.equal(missing.artist, track.artist);
  assert.equal(missing.duration, track.duration);
  assert.equal(missing.path, null);
  assert.equal(missing.coverPath, null);
  assert.deepEqual(resolvePlaylistTracks(reloaded[0], [track]), [track]);
});

test('removing a deleted record changes only the selected playlist', () => {
  const playlists = rememberPlaylistTracks([
    { id: 'a', name: 'A', trackIds: [track.id] },
    { id: 'b', name: 'B', trackIds: [track.id] },
  ], [track]);
  const removed = removePlaylistTrack(playlists[0], track.id);
  assert.deepEqual(removed.trackIds, []);
  assert.deepEqual(removed.trackMetadata, {});
  assert.deepEqual(playlists[0].trackIds, [track.id]);
  assert.equal(resolvePlaylistTracks(playlists[1], [])[0].title, track.title);
  assert.equal(track.path, 'song.mp3');
});
