# Lumi app

The Flutter web app of the carousel agent: Create, the room where the agents work live, the
community's line and the feed of carousels. The server (`../server`) serves the built app at
http://localhost:8787.

```bash
flutter build web                                              # what the server serves
flutter run -d chrome --dart-define=API_URL=http://localhost:8787   # hot reload against the server
flutter analyze
```

- `lib/main.dart`: the shell, Create and the tabs.
- `lib/room.dart`: the live run (steps, agents, slides, the ready window and the reel).
- `lib/queue.dart`: the line (community board) and the queue of batches.
- `lib/feed.dart`, `lib/learned.dart`: the carousels, the votes and what the agents learned.
- `lib/i18n.dart`, `lib/i18n/`: English is the key (`'Text'.tr`); the Spanish catalogs live in `lib/i18n/es_*.dart`.

See the [main README](../README.md) for the whole project.
