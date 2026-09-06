const db = require('./index')();

// Global, shared across every user - like artists/songs, not per-user. Each event's
// (source, raw_artist, date, venue) combo is its natural de-dupe key across re-fetches.
const upsertMany = async (events, knexInstance = db) => {
  for (const event of events) {
    const record = {
      source: event.source,
      raw_artist: event.rawArtist,
      date: event.date,
      date_label: event.dateLabel,
      venue: event.venue,
      city: event.city,
      neighborhood: event.neighborhood ?? null,
      time: event.time ?? null,
      genre: event.genre ?? null,
      ticket_url: event.ticketUrl ?? null,
    };

    const [{ id }] = await knexInstance('events')
      .insert(record)
      .onConflict(['source', 'raw_artist', 'date', 'venue'])
      .merge(record)
      .returning('id');

    for (const artist of event.hits) {
      await knexInstance('event_artists').insert({ event_id: id, artist_id: artist.id }).onConflict(['event_id', 'artist_id']).ignore();
    }
  }
};

// Same "visible to user" shape as artistsDb.getNamesForUser - an event is visible to a
// user only if it matched at least one artist that's actually in that user's own library.
const getForUser = async (userId, knexInstance = db) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await knexInstance('events as e')
    .where('e.date', '>=', today)
    .whereExists(
      knexInstance('event_artists as ea')
        .select(1)
        .join('song_artists as sa', 'sa.artist_id', 'ea.artist_id')
        .join('playlist_tracks as pt', 'pt.song_id', 'sa.song_id')
        .join('playlists as p', 'p.id', 'pt.playlist_id')
        .where('ea.event_id', knexInstance.ref('e.id'))
        .andWhere('p.user_id', userId)
    )
    .orderBy('e.date')
    .select('e.*');

  const artistsByEvent = await knexInstance('event_artists as ea')
    .join('artists as a', 'a.id', 'ea.artist_id')
    .whereIn('ea.event_id', rows.map((r) => r.id))
    .select({ eventId: 'ea.event_id', id: 'a.id', name: 'a.name' });

  // song_artists already has one row per (song, artist) - counting rows per artist_id,
  // scoped to this user's own playlist_tracks, is that artist's song count in their library.
  const songCountRows = await knexInstance('song_artists as sa')
    .whereExists(
      knexInstance('playlist_tracks as pt')
        .select(1)
        .join('playlists as p', 'p.id', 'pt.playlist_id')
        .where('pt.song_id', knexInstance.ref('sa.song_id'))
        .andWhere('p.user_id', userId)
    )
    .groupBy('sa.artist_id')
    .select('sa.artist_id')
    .count('* as count');
  const songCountByArtist = new Map(songCountRows.map((r) => [r.artist_id, r.count]));

  const artistMap = new Map();
  for (const row of artistsByEvent) {
    if (!artistMap.has(row.eventId)) artistMap.set(row.eventId, []);
    artistMap.get(row.eventId).push({ id: row.id, name: row.name, songCount: songCountByArtist.get(row.id) ?? 0 });
  }

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    rawArtist: row.raw_artist,
    date: row.date,
    dateLabel: row.date_label,
    venue: row.venue,
    city: row.city,
    neighborhood: row.neighborhood,
    time: row.time,
    genre: row.genre,
    ticketUrl: row.ticket_url,
    artists: artistMap.get(row.id) ?? [],
  }));
};

module.exports = { upsertMany, getForUser };
