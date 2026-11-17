import type { MusicPlaylist, MusicTrack } from "./api";

export function rememberPlaylistTracks(playlists: MusicPlaylist[], tracks: MusicTrack[]): MusicPlaylist[] {
  const byId = new Map(tracks.map(track => [track.id, track]));
  return playlists.map(playlist => {
    const trackMetadata = { ...playlist.trackMetadata };
    for (const id of playlist.trackIds) {
      const track = byId.get(id);
      if (track) {
        const { title, artist, album, duration } = track;
        trackMetadata[id] = { title, artist, album, duration };
      }
    }
    return { ...playlist, trackMetadata };
  });
}

export function resolvePlaylistTracks(playlist: MusicPlaylist, tracks: MusicTrack[]): MusicTrack[] {
  const byId = new Map(tracks.map(track => [track.id, track]));
  return playlist.trackIds.map(id => byId.get(id) ?? {
    id, title: "已删除歌曲", artist: "本地文件已删除", album: "已失效", duration: 0,
    ...playlist.trackMetadata?.[id], path: null, coverPath: null,
  });
}

export function removePlaylistTrack(playlist: MusicPlaylist, id: string): MusicPlaylist {
  const trackMetadata = { ...playlist.trackMetadata };
  delete trackMetadata[id];
  return { ...playlist, trackIds: playlist.trackIds.filter(trackId => trackId !== id), trackMetadata };
}
