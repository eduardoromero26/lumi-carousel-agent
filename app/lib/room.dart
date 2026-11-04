import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

import 'api.dart';
import 'main.dart' show mono, showBig;

// Design it live: a run told from the agents' side. The team lights up as each agent
// works, the slide is built in GIMP (its real layers, read from the .xcf), the critic is
// docked beside it and the owner asks the designer for changes below.
// A finished run replays faster; a live one follows as it happens.
// ?view=room opens the list of runs; ?view=room&run=<id> opens one.

// Lumi's look: white, thin borders, one violet, no shadows.
class _C {
  static const bg = Color(0xFFF4F3F8);
  static const panel = Color(0xFFFFFFFF);
  static const raised = Color(0xFFF6F5FA);
  static const line = Color(0xFFE7E5EF);
  static const text = Color(0xFF1B1540);
  static const muted = Color(0xFF5A5478);
  static const faint = Color(0xFF8A84A8);
  static const violet = Color(0xFF6D4AFF);
  static const ok = Color(0xFF0E8A6A);
  static const bad = Color(0xFFD92D20);
  static const warn = Color(0xFFB54708);
}

// GIMP 3's dark theme: neutral greys, so the window reads as the real app.
class _G {
  static const window = Color(0xFF2D2D2D);
  static const bar = Color(0xFF262626);
  static const dock = Color(0xFF333333);
  static const edge = Color(0xFF1C1C1C);
  static const canvas = Color(0xFF3D3D3D);
  static const ruler = Color(0xFF2A2A2A);
  static const text = Color(0xFFDADADA);
  static const dim = Color(0xFF9A9A9A);
  static const selected = Color(0xFF4A6587);
  static const boundary = Color(0xFFF2D21B);
}

class _Agent {
  const _Agent(this.key, this.name, this.job, this.models, this.icon, this.color);
  final String key;
  final String name;
  final String job;
  final List<String> models;
  final IconData icon;
  final Color color;
}

const _team = [
  _Agent('analyst', 'Analyst', 'Reads the business\'s website: finds its logo, colors and real photos, and cuts the products out of them.', ['Muse Spark', 'SAM 3.1'],
      Icons.travel_explore_rounded, Color(0xFF2563EB)),
  _Agent('director', 'Director', 'Decides what the carousel says: the story, slide by slide, with real facts from the website only.', ['Muse Spark'], Icons.movie_filter_outlined,
      Color(0xFF6D4AFF)),
  _Agent('art', 'Art director', 'Decides how it looks: fonts, colors and background, different from the last brands it designed.', ['Muse Wonder', 'Muse Image'],
      Icons.palette_outlined, Color(0xFFDB2777)),
  _Agent('designer', 'Designer', 'Builds every slide in GIMP, layer by layer, and the 30 s reel in HyperFrames.', ['GIMP 3', 'HyperFrames'], Icons.layers_outlined, Color(0xFF0E8A6A)),
  _Agent('critic', 'Critic', 'Checks every slide like a strict agency boss and rejects what isn\'t ready to publish.', ['Muse Spark'], Icons.gavel_rounded,
      Color(0xFFC2410C)),
  _Agent('fixer', 'Fixer', 'Turns the critic\'s notes into changes and rebuilds the slide until it passes.', ['Muse Spark'], Icons.auto_fix_high_rounded,
      Color(0xFFB45309)),
];

_Agent? _agent(String key) => _team.where((a) => a.key == key).firstOrNull;
Color _colorOf(String role) => _agent(role)?.color ?? _C.faint;

const _artLines = ['Setting the visual', 'Visual system', 'Art direction', 'So it doesn', 'Decor kit', 'Backdrop', 'In the style'];

// The server has four agent ids; the art director, the fixer and SAM's cut-outs are told
// apart by what they say.
String _roleOf(RunEvent e, Set<int> rejected) {
  // The reel: HyperFrames is the designer's other tool; the critic's fixes are the fixer's.
  if (e.agent == 'motion') return e.type == 'thought' && e.text.startsWith('Fixing the shots') ? 'fixer' : 'designer';
  if (e.agent != 'designer') return e.agent;
  if (e.slide == null && _artLines.any(e.text.startsWith)) return 'art';
  if (e.slide == null && e.text.contains(' cut out of photo')) return 'analyst';
  if (e.type == 'thought' && e.slide != null && rejected.contains(e.slide)) return 'fixer';
  return 'designer';
}

String _pretty(String k) {
  final s = k.replaceAll('_', ' ');
  return s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}

class _Round {
  _Round(this.url, this.label);
  final String url;
  final String label;
  int? score;
  bool? approved;
  final fails = <(String, String)>[];
  final fixes = <(String, String)>[];
  // Every check the critic answered, in order: (check, answer, note).
  final checks = <(String, String, String)>[];
}

class _Slide {
  _Slide(this.n);
  final int n;
  String? role;
  String? headline;
  String? url;
  bool? approved;
  bool done = false;
  final rounds = <_Round>[];
  final work = <String>[];
}

class _Line {
  _Line(this.role, this.event);
  final String role;
  final RunEvent event;
}

// Everything the room shows, read from the events shown so far.
class _View {
  _View(Iterable<RunEvent> events) {
    final rejected = <int>{};
    for (final e in events) {
      final role = _roleOf(e, rejected);
      final n = e.slide;
      final data = e.data;
      if (e.type == 'assets' && data is Map<String, dynamic>) site = data;
      if (e.agent == 'director' && e.type == 'thought' && data is Map<String, dynamic>) {
        plan = data;
        for (final p in (data['slides'] as List? ?? const [])) {
          if (p is! Map || p['n'] is! int) continue;
          slide(p['n'] as int)
            ..role = '${p['role'] ?? ''}'
            ..headline = '${p['headline'] ?? ''}';
        }
      }
      // The plan waits for the owner until this time; done once the owner or the clock answers.
      final wait = data is Map ? data['planWait'] : null;
      if (wait is Map) planUntil = wait['until'] is num ? DateTime.fromMillisecondsSinceEpoch((wait['until'] as num).toInt()) : null;
      final pick = data is Map ? data['pickWait'] : null;
      if (pick is Map) pickUntil = pick['until'] is num ? DateTime.fromMillisecondsSinceEpoch((pick['until'] as num).toInt()) : null;
      if (role == 'director') pickUntil = null;
      if (e.cost != null) cost = e.cost;
      if (e.tokens != null) tokens = e.tokens!;
      if (role == 'art') planUntil = null;
      final reading = RegExp(r'Reading (https?://\S+?)…').firstMatch(e.text);
      if (reading != null) url ??= reading[1];
      final read = RegExp(r'Read "([^"]+)"').firstMatch(e.text);
      if (read != null) business ??= read[1];
      final money = RegExp(r'US\$([\d.]+)').allMatches(e.text).lastOrNull;
      if (money != null) cost = double.tryParse(money[1]!) ?? cost;
      if (n != null) focus = n;
      // The reel comes after the carousel: its own phase, its shots and the critic's verdicts.
      if (e.agent == 'motion' || (data is Map && data['reel'] != null)) {
        reelPhase = true;
        if (e.type != 'done') finished = false;
      }
      if (data is Map && data['reel'] is Map && (data['reel'] as Map)['shots'] is List) {
        reelShots = [for (final x in (data['reel'] as Map)['shots'] as List) if (x is Map) _ReelShot.fromJson(x)];
        reelRound = ((data['reel'] as Map)['round'] as int?) ?? reelRound;
        reelMusic = ((data['reel'] as Map)['music'] as String?) ?? reelMusic;
        reelVerdicts.clear();
        reelSet = null;
      }
      if (e.type == 'review' && data is Map && data['reel'] == true) {
        if (data['shot'] is int) {
          reelVerdicts[data['shot'] as int] = data.cast<String, dynamic>();
        } else {
          reelSet = data.cast<String, dynamic>();
          reelPreview = data['video'] as String? ?? reelPreview;
        }
      }
      if (e.type == 'video' && data is Map && data['reel'] == true) {
        reelVideo = data['url'] as String?;
        reelPreview = reelVideo ?? reelPreview;
      }
      switch (e.type) {
        case 'snapshot' when n != null && data is Map:
          final s = slide(n);
          s.rounds.add(_Round('${data['url']}', e.text));
          s.url = '${data['url']}';
          s.done = false;
        case 'review':
          final score = (data is Map ? data['score'] as int? : null) ?? int.tryParse(RegExp(r'\((\d+)/10\)').firstMatch(e.text)?[1] ?? '');
          if (n == null) break;
          final s = slide(n);
          if (s.rounds.isEmpty) s.rounds.add(_Round(s.url ?? '', 'Round 1'));
          final r = s.rounds.last
            ..score = score
            ..approved = data is Map ? data['approved'] as bool? : e.text.startsWith('All checks');
          r.fails.clear();
          r.fixes.clear();
          final checks = data is Map ? data['checks'] : null;
          if (checks is Map) {
            r.checks.clear();
            checks.forEach((k, v) {
              if (v is Map) r.checks.add(('$k', '${v['answer'] ?? ''}', '${v['note'] ?? ''}'));
              if (v is Map && v['answer'] == 'no') r.fails.add(('$k', '${v['note'] ?? ''}'));
            });
          }
          final arrow = e.text.indexOf('→');
          if (arrow >= 0) {
            for (final m in RegExp(r'(\w+) \(([^)]*)\)').allMatches(e.text.substring(arrow + 1))) {
              r.fixes.add((m[1]!, m[2]!));
            }
          }
          if (r.approved == false) rejected.add(n);
        case 'slide' when n != null:
          final s = slide(n)..done = true;
          if (data is Map) {
            s.url = '${data['url'] ?? s.url}';
            s.approved = data['approved'] as bool?;
          }
        case 'tool' when n != null:
          slide(n).work.add(e.text);
        case 'status' when n != null && e.agent == 'designer':
          slide(n).work.add(e.text);
        case 'done':
          finished = true;
          if (data is Map && data['caption'] is String) {
            caption = data['caption'] as String;
            hashtags = hashtagsOf(data['hashtags']);
          }
        case 'error':
          error = e.text;
      }
      final line = _Line(role, e);
      lines.add(line);
      if (role != 'system') {
        said[role] = line;
        talks[role] = (talks[role] ?? 0) + 1;
        active = role;
      }
    }
  }

  Map<String, dynamic>? site;
  Map<String, dynamic>? plan;
  final slides = <int, _Slide>{};
  final lines = <_Line>[];
  final said = <String, _Line>{};
  final talks = <String, int>{};
  String? active;
  int? focus;
  double? cost;
  bool finished = false;
  bool reelPhase = false;
  List<_ReelShot>? reelShots;
  int reelRound = 0;
  String? reelMusic;
  final reelVerdicts = <int, Map<String, dynamic>>{};
  Map<String, dynamic>? reelSet;
  String? reelVideo;
  // The newest render, the final one or a round's: it stays while the next round renders.
  String? reelPreview;
  String? error;
  String? url;
  String? business;
  String? caption;
  List<String> hashtags = const [];
  DateTime? planUntil;
  DateTime? pickUntil;
  int tokens = 0;

  _Slide slide(int n) => slides.putIfAbsent(n, () => _Slide(n));

  List<int> get order => slides.keys.toList()..sort();
  bool get building => slides.values.any((s) => s.rounds.isNotEmpty);
}

// One layer of an .xcf: what GIMP's Layers dock lists.
class _Layer {
  const _Layer(this.name, this.w, this.h, this.x, this.y, this.visible, this.text);
  final String name;
  final int w;
  final int h;
  final int x;
  final int y;
  final bool visible;
  final bool text;
}

class _Xcf {
  const _Xcf(this.width, this.height, this.layers);
  final int width;
  final int height;
  final List<_Layer> layers;
}

// The layer list of an .xcf, top first: header, image properties, layer pointers, then
// each layer's size, name and properties (visible 8, offsets 15, text layer 26).
_Xcf? _readXcf(Uint8List bytes) {
  try {
    if (bytes.length < 30 || String.fromCharCodes(bytes.sublist(0, 9)) != 'gimp xcf ') return null;
    final d = ByteData.sublistView(bytes);
    final version = int.tryParse(String.fromCharCodes(bytes.sublist(10, 13))) ?? 0;
    var p = 14;
    int u32() {
      final v = d.getUint32(p);
      p += 4;
      return v;
    }

    // Version 11 and up: 64-bit pointers (getUint64 doesn't exist on the web).
    int pointer() => version >= 11 ? u32() * 4294967296 + u32() : u32();
    final width = u32();
    final height = u32();
    u32();
    if (version >= 4) u32();
    while (true) {
      final type = u32();
      final length = u32();
      if (type == 0) break;
      p += length;
    }
    final pointers = <int>[];
    while (true) {
      final q = pointer();
      if (q == 0) break;
      pointers.add(q);
    }
    final layers = <_Layer>[];
    for (final q in pointers) {
      p = q;
      final w = u32();
      final h = u32();
      u32();
      final n = u32();
      final name = utf8.decode(bytes.sublist(p, p + n - 1), allowMalformed: true);
      p += n;
      var visible = true;
      var text = false;
      var x = 0;
      var y = 0;
      while (true) {
        final type = u32();
        final length = u32();
        if (type == 0) break;
        if (type == 8) visible = d.getUint32(p) != 0;
        if (type == 15) {
          x = d.getInt32(p);
          y = d.getInt32(p + 4);
        }
        if (type == 26) text = true;
        p += length;
      }
      layers.add(_Layer(name, w, h, x, y, visible, text));
    }
    return _Xcf(width, height, layers);
  } catch (_) {
    return null;
  }
}

// The carousel Create just started: the room opens it even when the queue doesn't know it
// (and before the server says it's the current one).
final liveRun = ValueNotifier<String?>(null);

// The run Create shows, opened in its edit view (this room).
final editRun = ValueNotifier<String?>(null);

// The room's run, opened in the normal view (Create).
final normalRun = ValueNotifier<String?>(null);
void openNormalView(String id) {
  normalRun.value = null;
  normalRun.value = id;
}
void openEditView(String id) {
  editRun.value = null;
  editRun.value = id;
}

// Embedded is the "Design it live" tab: it opens the run being made and moves on to the
// next one when it starts. Standalone (?view=room) keeps the run in the URL.
class RoomPage extends StatefulWidget {
  const RoomPage({super.key, this.embedded = false, this.active = true, this.onExit});
  final bool embedded;
  final bool active;
  // Back to the app: the room is full screen, without the app's menu.
  final VoidCallback? onExit;

  @override
  State<RoomPage> createState() => _RoomPageState();
}

class _RoomPageState extends State<RoomPage> {
  late String? runId = widget.embedded ? null : Uri.base.queryParameters['run'];
  // Following the run being made: when the next one starts, the room moves to it.
  late bool follow = runId == null;
  List<Map<String, dynamic>> feed = [];
  String? live;
  bool loading = true;
  Timer? poll;

  @override
  void initState() {
    super.initState();
    load();
    poll = Timer.periodic(const Duration(seconds: 8), (_) => checkQueue());
    liveRun.addListener(onCreate);
    editRun.addListener(onEdit);
  }

  void onEdit() {
    final id = editRun.value;
    if (id == null || !mounted) return;
    setState(() {
      runId = id;
      follow = true;
    });
  }

  void onCreate() {
    final id = liveRun.value;
    if (id == null || !mounted) return;
    setState(() {
      live = id;
      follow = true;
      runId = id;
    });
  }

  @override
  void didUpdateWidget(RoomPage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) checkQueue();
  }

  @override
  void dispose() {
    poll?.cancel();
    liveRun.removeListener(onCreate);
    editRun.removeListener(onEdit);
    super.dispose();
  }

  Future<void> load() async {
    try {
      final f = await Api.feed();
      if (mounted) setState(() => feed = f);
    } catch (_) {}
    await checkQueue();
    if (mounted) setState(() => loading = false);
  }

  Future<void> checkQueue() async {
    if (!widget.active) return;
    String? running;
    try {
      final q = await Api.queue();
      // `current` covers a run from Create too; `running` is for a server that predates it.
      running = (q['current'] ?? q['running']) as String?;
      if (running == null && q['busy'] == true) running = liveRun.value;
    } catch (_) {
      return;
    }
    if (!mounted) return;
    setState(() {
      live = running;
      if (follow && running != null && running != runId) runId = running;
    });
    if (follow && running != null && !feed.any((f) => f['id'] == running)) {
      // The live run's name comes with the feed once it's saved.
      Api.feed().then((f) {
        if (mounted) setState(() => feed = f);
      }, onError: (_) {});
    }
  }

  void open(String? id) {
    setState(() {
      runId = id;
      follow = id != null && id == live;
    });
    if (!widget.embedded) {
      final query = {'view': 'room', 'run': ?id};
      web.window.history.replaceState(null, '', Uri.base.replace(queryParameters: query).toString());
    }
    if (id == null) load();
  }

  @override
  Widget build(BuildContext context) {
    final dark = ThemeData(
      brightness: Brightness.light,
      scaffoldBackgroundColor: _C.bg,
      colorScheme: ColorScheme.fromSeed(seedColor: _C.violet, primary: _C.violet, surface: _C.panel, onSurface: _C.text),
      textTheme: GoogleFonts.plusJakartaSansTextTheme().apply(bodyColor: _C.text, displayColor: _C.text),
      dividerTheme: const DividerThemeData(color: _C.line, thickness: 1, space: 1),
      tooltipTheme: const TooltipThemeData(waitDuration: Duration(milliseconds: 400)),
    );
    final id = runId;
    return Theme(
      data: dark,
      child: Scaffold(
        body: SafeArea(
          child: id == null
              ? _Picker(feed: feed, live: live, loading: loading, onOpen: open, onExit: widget.onExit)
              : _Room(
                  key: ValueKey(id),
                  runId: id,
                  live: id == live || follow,
                  info: feed.where((f) => f['id'] == id).firstOrNull,
                  onBack: () => open(null),
                  onExit: widget.onExit,
                ),
        ),
      ),
    );
  }
}

// The runs to open: the one being made now and every finished carousel.
class _Picker extends StatelessWidget {
  const _Picker({required this.feed, required this.live, required this.loading, required this.onOpen, this.onExit});
  final VoidCallback? onExit;
  final List<Map<String, dynamic>> feed;
  final String? live;
  final bool loading;
  final void Function(String) onOpen;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(slivers: [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(24, 24, 32, 8),
        sliver: SliverToBoxAdapter(
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (onExit != null) IconButton(tooltip: 'Close', onPressed: onExit, icon: const Icon(Icons.close_rounded, color: _C.muted)),
            const SizedBox(width: 8),
            const Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Design it live', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.4)),
                SizedBox(height: 4),
                Text('Watch the agents make a carousel in GIMP, or open one they already made.', style: TextStyle(color: _C.muted, fontSize: 14.5)),
              ]),
            ),
          ]),
        ),
      ),
      if (live != null)
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(32, 20, 32, 0),
          sliver: SliverToBoxAdapter(
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => onOpen(live!),
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: _C.panel, borderRadius: BorderRadius.circular(12), border: Border.all(color: _C.violet)),
                child: Row(children: [
                  const _Pill(text: 'Live', color: _C.bad, blink: true),
                  const SizedBox(width: 12),
                  Text('The agents are making a carousel right now', style: TextStyle(color: _C.text.withValues(alpha: 0.9))),
                  const Spacer(),
                  Text('Watch →', style: mono(color: _C.violet, size: 13, weight: FontWeight.w700)),
                ]),
              ),
            ),
          ),
        ),
      if (loading)
        const SliverFillRemaining(child: Center(child: CircularProgressIndicator()))
      else
        SliverPadding(
          padding: const EdgeInsets.all(32),
          sliver: SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                maxCrossAxisExtent: 220, mainAxisSpacing: 16, crossAxisSpacing: 16, childAspectRatio: 0.66),
            itemCount: feed.length,
            itemBuilder: (context, i) {
              final f = feed[i];
              final cover = (f['slides'] as List?)?.firstOrNull as Map?;
              final stars = f['stars'] as int?;
              return InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () => onOpen('${f['id']}'),
                child: Container(
                  decoration: BoxDecoration(color: _C.panel, borderRadius: BorderRadius.circular(10), border: Border.all(color: _C.line)),
                  clipBehavior: Clip.antiAlias,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    AspectRatio(
                      aspectRatio: 4 / 5,
                      child: cover == null ? const ColoredBox(color: _G.canvas) : _Net('${cover['url']}', fit: BoxFit.cover),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                      child: Text('${f['business'] ?? f['id']}',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                    ),
                    if (stars != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 2, 10, 0),
                        child: Text('★' * stars, style: mono(size: 11, color: stars >= 4 ? _C.warn : _C.faint)),
                      ),
                  ]),
                ),
              );
            },
          ),
        ),
    ]);
  }
}

class _Room extends StatefulWidget {
  const _Room({super.key, required this.runId, required this.live, required this.info, required this.onBack, this.onExit});
  final String runId;
  final VoidCallback? onExit;
  // The run being made now: the room opens where it is, not at its start.
  final bool live;
  final Map<String, dynamic>? info;
  final VoidCallback onBack;

  @override
  State<_Room> createState() => _RoomState();
}

class _RoomState extends State<_Room> {
  static const cap = Duration(seconds: 5);
  static const step = Duration(milliseconds: 50);
  final all = <RunEvent>[];
  final offsets = <Duration>[];
  StreamSubscription<RunEvent>? sub;
  Timer? ticker;
  int shown = 0;
  Duration clock = Duration.zero;
  double speed = 4;
  bool playing = true;
  int? pinSlide;
  int? pinRound;
  // The team chat wide, to read the agents talking.
  bool chatWide = false;
  // Website images (asset ids) the owner left out; they go with the plan's approval.
  final excluded = <String>{};
  bool imagesSent = false;
  void toggleAsset(String id) => setState(() => excluded.contains(id) ? excluded.remove(id) : excluded.add(id));
  // GIMP, the feed preview or the reel; null follows the run (the reel once it starts).
  String? stageTab;
  int? reelShot;
  // Live: every event shows as it arrives, until the owner rewinds.
  late bool catchUp = widget.live;
  // The owner's change in progress: the slide and where its events start.
  ({int slide, int from})? editing;

  @override
  void initState() {
    super.initState();
    sub = Api.events(widget.runId).listen(add);
    ticker = Timer.periodic(step, (_) => tick());
  }

  @override
  void dispose() {
    sub?.cancel();
    ticker?.cancel();
    super.dispose();
  }

  void add(RunEvent e) {
    if (all.any((x) => x.seq == e.seq)) return;
    all.add(e);
    if (all.length > 1 && all[all.length - 2].seq > e.seq) {
      all.sort((a, b) => a.seq.compareTo(b.seq));
      offsets.clear();
      for (var i = 0; i < all.length; i++) {
        offsets.add(next(i));
      }
    } else {
      offsets.add(next(all.length - 1));
    }
    final edit = editing;
    if (edit != null && all.length > edit.from && ((e.type == 'slide' && e.slide == edit.slide) || e.type == 'error')) editing = null;
    setState(() {});
  }

  // The replay's clock: the run's own gaps, the long waits on the models cut to 5 s.
  Duration next(int i) {
    if (i == 0) return Duration.zero;
    final a = all[i - 1].at;
    final b = all[i].at;
    var gap = a == null || b == null ? const Duration(milliseconds: 300) : b.difference(a);
    if (gap.isNegative) gap = Duration.zero;
    return offsets[i - 1] + (gap > cap ? cap : gap);
  }

  void tick() {
    if (all.isEmpty) return;
    if (catchUp) {
      if (shown != all.length) setState(() => shown = all.length);
      clock = offsets.last;
      return;
    }
    if (!playing) return;
    clock += step * speed;
    final end = offsets.last + cap;
    if (clock > end) clock = end;
    var n = shown;
    while (n < all.length && offsets[n] <= clock) {
      n++;
    }
    if (n != shown) setState(() => shown = n);
  }

  void seek(int n) => setState(() {
        catchUp = n >= all.length && widget.live;
        shown = n.clamp(0, all.length);
        clock = shown == 0 ? Duration.zero : offsets[shown - 1];
        playing = true;
      });

  void pin(int? n, [int? round]) => setState(() {
        pinSlide = n;
        pinRound = round;
      });

  bool get ended => all.isNotEmpty && (all.last.type == 'done' || all.last.type == 'error');
  bool get liveNow => widget.live && !ended;

  // The owner writes to the director; the answer and the changes show as they happen.
  Future<String?> talk(String text) async {
    try {
      await Api.chat(widget.runId, text);
      setState(() => catchUp = true);
      return null;
    } catch (e) {
      return '$e'.replaceFirst('Exception: ', '');
    }
  }

  // The owner's change: the designer redoes the slide and the room shows it as it happens.
  Future<String?> edit(int n, String feedback) async {
    try {
      await Api.editSlide(widget.runId, n, feedback);
      setState(() {
        editing = (slide: n, from: all.length);
        catchUp = true;
        pinSlide = n;
        pinRound = null;
      });
      return null;
    } catch (e) {
      return '$e'.replaceFirst('Exception: ', '');
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = _View(all.take(shown));
    final focus = pinSlide ?? v.focus;
    final slide = focus == null ? null : v.slides[focus];
    final width = MediaQuery.sizeOf(context).width;
    final replay = !liveNow && editing == null;
    final status = v.error != null
        ? ('Stopped', _C.bad, false)
        : editing != null
            ? ('Editing slide ${editing!.slide}', _C.violet, true)
            : liveNow
                ? ('Live', _C.bad, true)
                : v.finished && shown >= all.length
                    ? ('Ready${v.cost == null ? '' : ' · US\$${v.cost!.toStringAsFixed(2)}'}', _C.ok, false)
                    : ('Replay', _C.violet, false);
    final header = _Header(
      spend: v.tokens > 0 || v.cost != null ? (v.tokens, v.cost) : null,
      // Live it runs on the wall clock; in a replay, how long the run had gone at that point.
      started: all.firstOrNull?.at,
      until: liveNow ? null : (shown > 0 ? all[shown - 1].at : all.firstOrNull?.at),
      onStop: liveNow || editing != null
          ? () => Api.stop(widget.runId).catchError((Object e) {
                if (context.mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('$e'.replaceFirst('Exception: ', ''))));
              })
          : null,
      name: '',
      url: '${widget.info?['url'] ?? v.url ?? ''}',
      logo: (v.site?['logo'] ?? widget.info?['logo']) as String?,
      status: status,
      replay: replay
          ? _Replay(
              shown: shown,
              total: all.length,
              speed: speed,
              playing: playing,
              onSpeed: (s) => setState(() => speed = s),
              onPlay: () => setState(() => playing = !playing),
              onRestart: () => seek(0),
              onEnd: () => seek(all.length),
              onSeek: seek,
            )
          : null,
      toggle: null,
      onBack: widget.onBack,
      onExit: widget.onExit,
    );
    final progress = _Progress(view: v);
    final busyNow = liveNow || editing != null || (!v.finished && v.error == null && shown < all.length);
    final Widget work;
    if (v.error != null && !v.building) {
      work = _Message(icon: Icons.error_outline_rounded, color: _C.bad, title: 'The run stopped', text: v.error!);
    } else if (v.plan == null) {
      work = _Reading(
        view: v,
        excluded: excluded,
        onToggle: toggleAsset,
        onConfirm: liveNow && v.pickUntil != null && v.pickUntil!.isAfter(DateTime.now()) && !imagesSent
            ? () async {
                try {
                  await Api.pickImages(widget.runId, excluded.toList());
                  setState(() => imagesSent = true);
                } catch (e) {
                  if (context.mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('$e'.replaceFirst('Exception: ', ''))));
                }
              }
            : null,
      );
    } else if (!v.building || slide == null) {
      work = _PlanBoard(runId: widget.runId, view: v, live: liveNow, excluded: excluded, onToggle: toggleAsset);
    } else {
      work = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: _Gimp(
            runId: widget.runId,
            view: v,
            slide: slide,
            round: pinSlide == focus ? pinRound : null,
            pinned: pinSlide != null,
            onPin: pin,
            busy: busyNow,
            canEdit: v.finished && !liveNow && editing == null && shown >= all.length,
            onEdit: edit,
          ),
        ),
      ]);
    }
    final tab = stageTab ?? (v.reelShots != null && v.reelPhase ? 'reel' : 'gimp');
    final Widget stageWork = !v.building
        ? work
        : switch (tab) {
            'reel' when v.reelShots != null => _ReelEditor(runId: widget.runId, view: v, selected: reelShot, onSelect: (n) => setState(() => reelShot = n)),
            'preview' => _FeedPreview(view: v, host: '${widget.info?['url'] ?? v.url ?? ''}'),
            _ => work,
          };
    final stage = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (v.building) ...[
        Row(children: [
          _Tab(label: 'Editor', icon: Icons.layers_outlined, on: tab == 'gimp', onTap: () => setState(() => stageTab = 'gimp')),
          const SizedBox(width: 6),
          _Tab(label: 'Preview', icon: Icons.phone_iphone_rounded, on: tab == 'preview', onTap: () => setState(() => stageTab = 'preview')),
          if (v.reelShots != null) ...[
            const SizedBox(width: 6),
            _Tab(label: 'Reel', icon: Icons.movie_outlined, on: tab == 'reel', onTap: () => setState(() => stageTab = 'reel')),
          ],
        ]),
        const SizedBox(height: 10),
      ],
      Expanded(child: AnimatedSwitcher(duration: const Duration(milliseconds: 300), child: KeyedSubtree(key: ValueKey(stageWork.runtimeType), child: stageWork))),
    ]);
    final team = _TeamChat(
      view: v,
      busy: busyNow,
      wide: chatWide,
      onWide: () => setState(() => chatWide = !chatWide),
      canTalk: v.finished && !busyNow && shown >= all.length,
      onSend: talk,
    );
    if (width < 1100) {
      return Column(children: [
        header,
        progress,
        Expanded(
          child: ListView(padding: const EdgeInsets.all(12), children: [
            SizedBox(height: 820, child: stage),
            const SizedBox(height: 12),
            SizedBox(height: 760, child: team),
          ]),
        ),
      ]);
    }
    return Column(children: [
      header,
      progress,
      Expanded(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: stage),
            const SizedBox(width: 14),
            AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              curve: Curves.easeOut,
              width: chatWide ? (width * 0.45).clamp(480.0, 760.0) : (width > 1500 ? 380 : 340),
              child: team,
            ),
          ]),
        ),
      ),
    ]);
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.name, required this.url, required this.logo, required this.status, required this.replay, required this.toggle, required this.onBack, this.onExit, this.spend, this.onStop, this.started, this.until});
  // Tokens and dollars spent so far; the stop button while the agents work.
  final (int, double?)? spend;
  final DateTime? started;
  // Null while live: the timer keeps counting.
  final DateTime? until;
  final VoidCallback? onStop;
  final VoidCallback? onExit;
  final String name;
  final Widget? toggle;
  final String url;
  final String? logo;
  final (String, Color, bool) status;
  // Null when the run is live: there is nothing to rewind.
  final _Replay? replay;
  final VoidCallback onBack;

  // The website without its scheme and "www.": what the owner knows it by.
  String get host => (Uri.tryParse(url)?.host ?? '').replaceFirst(RegExp(r'^www\.'), '');

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(color: _C.panel, border: Border(bottom: BorderSide(color: _C.line))),
      child: Column(children: [
        SizedBox(
          height: 56,
          child: Row(children: [
            const SizedBox(width: 8),
            if (onExit != null) IconButton(tooltip: 'Close', onPressed: onExit, icon: const Icon(Icons.close_rounded, color: _C.muted)),
            // Standalone (?view=room) there is no app to close back to: the arrow goes to the list.
            if (onExit == null) IconButton(tooltip: 'All carousels', onPressed: onBack, icon: const Icon(Icons.arrow_back_rounded, color: _C.muted)),
            Container(
              width: 34,
              height: 34,
              padding: const EdgeInsets.all(4),
              margin: const EdgeInsets.only(right: 10),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8), border: Border.all(color: _C.line)),
              child: logo != null
                  ? _Net(logo!, fit: BoxFit.contain)
                  : host.isEmpty
                      ? const Icon(Icons.public_rounded, size: 18, color: _C.faint)
                      : Image.network(
                          'https://$host/favicon.ico',
                          fit: BoxFit.contain,
                          errorBuilder: (_, _, _) => const Icon(Icons.public_rounded, size: 18, color: _C.faint),
                        ),
            ),
            Flexible(
              child: Text(host.isEmpty ? 'Opening the website…' : host, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            ),
            const SizedBox(width: 14),
            _Pill(text: status.$1, color: status.$2, blink: status.$3),
            const Spacer(),
            ?toggle,
            const SizedBox(width: 12),
            if (started != null) _Elapsed(started: started!, until: until),
            if (spend != null)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                margin: const EdgeInsets.only(right: 8),
                decoration: BoxDecoration(color: _C.raised, borderRadius: BorderRadius.circular(8), border: Border.all(color: _C.line)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.token_outlined, size: 15, color: _C.muted),
                  const SizedBox(width: 6),
                  Text(
                    '${spend!.$1 >= 1000 ? '${(spend!.$1 / 1000).toStringAsFixed(1)}k' : spend!.$1} tokens${spend!.$2 != null ? ' · US\$${spend!.$2!.toStringAsFixed(2)}' : ''}',
                    style: mono(size: 12, color: _C.text, weight: FontWeight.w700),
                  ),
                ]),
              ),
            if (onStop != null)
              OutlinedButton.icon(
                onPressed: onStop,
                style: OutlinedButton.styleFrom(foregroundColor: _C.bad, side: const BorderSide(color: _C.bad), minimumSize: const Size(0, 36)),
                icon: const Icon(Icons.stop_circle_outlined, size: 18),
                label: const Text('Stop'),
              ),
            const SizedBox(width: 8),
            ?replay,
            const SizedBox(width: 8),
          ]),
        ),
        if (replay != null) replay!.bar(),
      ]),
    );
  }
}

// How long the run has been going: ticks every second while live.
class _Elapsed extends StatefulWidget {
  const _Elapsed({required this.started, this.until});
  final DateTime started;
  final DateTime? until;

  @override
  State<_Elapsed> createState() => _ElapsedState();
}

class _ElapsedState extends State<_Elapsed> {
  Timer? tick;

  @override
  void initState() {
    super.initState();
    tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (widget.until == null && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    var d = (widget.until ?? DateTime.now()).difference(widget.started);
    if (d.isNegative) d = Duration.zero;
    String two(int x) => x.toString().padLeft(2, '0');
    final text = d.inHours > 0 ? '${d.inHours}:${two(d.inMinutes % 60)}:${two(d.inSeconds % 60)}' : '${d.inMinutes}:${two(d.inSeconds % 60)}';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      margin: const EdgeInsets.only(right: 8),
      decoration: BoxDecoration(color: _C.raised, borderRadius: BorderRadius.circular(8), border: Border.all(color: _C.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.timer_outlined, size: 15, color: _C.muted),
        const SizedBox(width: 6),
        Text(text, style: mono(size: 12, color: _C.text, weight: FontWeight.w700)),
      ]),
    );
  }
}

class _Replay extends StatelessWidget {
  const _Replay({
    required this.shown,
    required this.total,
    required this.speed,
    required this.playing,
    required this.onSpeed,
    required this.onPlay,
    required this.onRestart,
    required this.onEnd,
    required this.onSeek,
  });
  final int shown;
  final int total;
  final double speed;
  final bool playing;
  final void Function(double) onSpeed;
  final VoidCallback onPlay;
  final VoidCallback onRestart;
  final VoidCallback onEnd;
  final void Function(int) onSeek;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        for (final s in const [1.0, 4.0, 16.0])
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: InkWell(
              borderRadius: BorderRadius.circular(6),
              onTap: () => onSpeed(s),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                decoration: BoxDecoration(
                  color: speed == s ? _C.violet.withValues(alpha: 0.18) : Colors.transparent,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: speed == s ? _C.violet : _C.line),
                ),
                child: Text('×${s.toInt()}', style: mono(size: 11.5, color: speed == s ? _C.text : _C.muted, weight: FontWeight.w700)),
              ),
            ),
          ),
        IconButton(tooltip: playing ? 'Pause' : 'Play', onPressed: onPlay, icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded, color: _C.text)),
        IconButton(tooltip: 'From the start', onPressed: onRestart, icon: const Icon(Icons.replay_rounded, color: _C.muted)),
        IconButton(tooltip: 'Jump to the end', onPressed: onEnd, icon: const Icon(Icons.skip_next_rounded, color: _C.muted)),
      ]);

  // Where the replay is; a tap jumps there.
  Widget bar() => LayoutBuilder(builder: (context, c) {
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => onSeek((d.localPosition.dx / c.maxWidth * total).round()),
          child: SizedBox(
            height: 6,
            child: Stack(children: [
              Positioned(left: 0, top: 2, bottom: 2, width: total == 0 ? 0 : c.maxWidth * shown / total, child: const ColoredBox(color: _C.violet)),
            ]),
          ),
        );
      });
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.agent, required this.working, required this.idle, this.size = 34});
  final _Agent agent;
  final bool working;
  final bool idle;
  final double size;

  @override
  Widget build(BuildContext context) {
    final dot = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: working ? agent.color : agent.color.withValues(alpha: idle ? 0.08 : 0.18),
        border: Border.all(color: agent.color.withValues(alpha: idle ? 0.3 : 1)),
      ),
      child: Icon(agent.icon, size: size * 0.52, color: working ? Colors.white : (idle ? agent.color.withValues(alpha: 0.5) : agent.color)),
    );
    return working ? _Blink(child: dot) : dot;
  }
}

// Before the plan: the website as the analyst reads it.
class _Reading extends StatelessWidget {
  const _Reading({required this.view, required this.excluded, required this.onToggle, this.onConfirm});
  final _View view;
  final Set<String> excluded;
  final void Function(String) onToggle;
  // While the analyst waits for the owner: sends the images left out; the director starts.
  final VoidCallback? onConfirm;

  @override
  Widget build(BuildContext context) {
    final site = view.site;
    final last = view.said['analyst']?.event.text ?? view.lines.lastOrNull?.event.text ?? 'Opening the website…';
    if (site == null) {
      return _Panel(
        title: 'Reading the website',
        child: _Message(icon: Icons.travel_explore_rounded, color: _colorOf('analyst'), title: 'The analyst is reading the website', text: last, blink: true),
      );
    }
    final assets = (site['assets'] as List? ?? const []).whereType<Map>().where((a) => a['kind'] != 'icon').take(24).toList();
    final colors = (site['colors'] as List? ?? const []).map((c) => '$c').toList();
    return _Panel(
      title: 'What the analyst found on the website',
      trailing: Text('${assets.length} images', style: mono(size: 11, color: _C.faint)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            if (site['logo'] != null)
              Container(
                height: 56,
                width: 120,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
                child: _Net('${site['logo']}', fit: BoxFit.contain),
              ),
            const SizedBox(width: 14),
            for (final c in colors)
              Container(
                width: 36,
                height: 36,
                margin: const EdgeInsets.only(right: 6),
                decoration: BoxDecoration(color: _hex(c), borderRadius: BorderRadius.circular(8), border: Border.all(color: _C.line)),
              ),
            const SizedBox(width: 8),
            Expanded(child: Text(view.said['analyst']?.event.text ?? '', maxLines: 3, style: const TextStyle(color: _C.muted, fontSize: 12.5))),
          ]),
          const SizedBox(height: 16),
          if (onConfirm != null)
            Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
              decoration: BoxDecoration(color: _C.violet.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(10), border: Border.all(color: _C.violet.withValues(alpha: 0.4))),
              child: Row(children: [
                _Countdown(until: view.pickUntil!, label: 'Director starts in'),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    excluded.isEmpty ? 'Open any image to see what the AI read in it, and leave out the ones you don\'t want.' : '${excluded.length} left out: the director won\'t use them.',
                    style: const TextStyle(fontSize: 13, color: _C.muted),
                  ),
                ),
                FilledButton.icon(onPressed: onConfirm, icon: const Icon(Icons.check_rounded), label: const Text('Confirm images')),
              ]),
            ),
          Expanded(
            child: GridView.builder(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 130, mainAxisSpacing: 8, crossAxisSpacing: 8),
              itemCount: assets.length,
              itemBuilder: (context, i) => Stack(fit: StackFit.expand, children: [
                GestureDetector(
                  onTap: () => showAsset(context, assets[i], excluded.contains('${assets[i]['id']}'), () => onToggle('${assets[i]['id']}')),
                  child: Opacity(
                    opacity: excluded.contains('${assets[i]['id']}') ? 0.35 : 1,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: ColoredBox(color: _G.canvas, child: _Net('${assets[i]['url']}', fit: BoxFit.cover)),
                    ),
                  ),
                ),
                if (excluded.contains('${assets[i]['id']}'))
                  const Positioned(right: 5, top: 5, child: _Pill(text: 'Left out', color: _C.bad)),
                Positioned(
                  left: 5,
                  bottom: 5,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.65), borderRadius: BorderRadius.circular(4)),
                    child: Text('${assets[i]['kind']}', style: mono(size: 9.5, color: Colors.white)),
                  ),
                ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

typedef _RunPhoto = ({String id, String url, String note, bool cutout, String asset});

// The run's photos (from its run.json) and the photo each slide of the plan uses.
Future<(List<_RunPhoto>, Map<int, String>)> _runPhotos(String runId) async {
  final res = await http.get(Uri.parse(Api.fileUrl('/files/$runId/run.json?v=${DateTime.now().millisecondsSinceEpoch}')));
  if (res.statusCode != 200) return (const <_RunPhoto>[], const <int, String>{});
  final run = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  final marker = '/runs/$runId/';
  final list = <_RunPhoto>[];
  for (final p in (run['photos'] as List? ?? const [])) {
    if (p is! Map || p['backdrop'] == true) continue;
    final path = '${p['path']}'.replaceAll('\\', '/');
    final at = path.indexOf(marker);
    if (at < 0) continue;
    list.add((id: '${p['id']}', url: '/files/$runId/${path.substring(at + marker.length)}', note: '${p['note'] ?? ''}', cutout: p['cutout'] == true, asset: '${p['asset'] ?? ''}'));
  }
  final used = <int, String>{
    for (final sl in (((run['plan'] as Map?)?['slides'] as List?) ?? const []))
      if (sl is Map && sl['n'] is int && sl['photo'] is String) sl['n'] as int: sl['photo'] as String,
  };
  return (list, used);
}


// GIMP, as the designer is using it: the set as image tabs, the toolbox, the canvas with
// rulers, the Layers dock read from the slide's real .xcf, and the critic docked below it.
class _Gimp extends StatefulWidget {
  const _Gimp({required this.runId, required this.view, required this.slide, required this.round, required this.pinned, required this.onPin, required this.busy, required this.canEdit, required this.onEdit});
  // The owner's changes go to the designer, as the edit bar does, when the carousel is ready.
  final bool canEdit;
  final Future<String?> Function(int, String) onEdit;
  // An agent is at work: its pointer keeps moving over the layers.
  final bool busy;
  final String runId;
  final _View view;
  final _Slide slide;
  final int? round;
  final bool pinned;
  final void Function(int?, [int?]) onPin;

  @override
  State<_Gimp> createState() => _GimpState();
}

class _GimpState extends State<_Gimp> {
  final cache = <String, _Xcf?>{};
  String? path;
  _Xcf? xcf;
  int? layer;
  int? hover;
  Timer? assemble;
  Timer? wander;
  // The run's photos (run.json) and the photo each slide uses now.
  List<_RunPhoto> photos = const [];
  Map<int, String> slidePhotos = const {};
  bool photosTab = false;

  @override
  void initState() {
    super.initState();
    sync();
    loadPhotos();
    // While an agent works, its pointer goes from layer to layer, as a designer's mouse would.
    wander = Timer.periodic(const Duration(milliseconds: 1500), (_) {
      final count = xcf?.layers.length ?? 0;
      if (!widget.busy || count == 0 || hover != null || (assemble?.isActive ?? false) || !mounted) return;
      setState(() => layer = ((layer ?? 0) + count - 1) % count);
    });
  }

  @override
  void didUpdateWidget(_Gimp old) {
    super.didUpdateWidget(old);
    sync();
  }

  @override
  void dispose() {
    assemble?.cancel();
    wander?.cancel();
    super.dispose();
  }

  // The .xcf behind what the canvas shows: the round picked, the saved slide, or the
  // newest round while the designer works.
  String? xcfPath() {
    final s = widget.slide;
    if (widget.round != null) return 'snaps/s${s.n}-r${widget.round}.xcf';
    if (s.done) return 'slide-${s.n}.xcf?v=${Uri.tryParse(s.url ?? '')?.queryParameters['v'] ?? ''}';
    if (s.rounds.isNotEmpty) return 'snaps/s${s.n}-r${s.rounds.length - 1}.xcf';
    return null;
  }

  void sync() {
    final next = xcfPath();
    if (next == null || next == path) return;
    path = next;
    if (cache.containsKey(next)) {
      setState(() => xcf = cache[next] ?? xcf);
      return;
    }
    http.get(Uri.parse(Api.fileUrl('/files/${widget.runId}/$next'))).then((res) {
      final read = res.statusCode == 200 ? _readXcf(res.bodyBytes) : null;
      cache[next] = read;
      if (!mounted || path != next || read == null) return;
      setState(() => xcf = read);
      build_();
    }, onError: (_) {});
  }

  // A new version: its layers light up from the bottom to the top, as they were stacked.
  void build_() {
    assemble?.cancel();
    final layers = xcf?.layers ?? const [];
    if (layers.isEmpty) return;
    var i = layers.length - 1;
    setState(() => layer = i);
    assemble = Timer.periodic(const Duration(milliseconds: 260), (t) {
      i--;
      if (i < 0 || !mounted) {
        t.cancel();
        final headline = layers.indexWhere((l) => l.text);
        if (mounted) setState(() => layer = headline < 0 ? 0 : headline);
        return;
      }
      setState(() => layer = i);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.slide;
    final rounds = s.rounds;
    final chosen = widget.round != null && widget.round! < rounds.length ? widget.round : null;
    final image = chosen != null ? rounds[chosen].url : s.url;
    final roundShown = chosen != null ? rounds[chosen] : rounds.lastOrNull;
    final layers = xcf?.layers ?? const <_Layer>[];
    final current = hover ?? layer;
    final active = current != null && current < layers.length ? layers[current] : null;
    final judged = chosen != null ? rounds[chosen] : rounds.lastWhere((r) => r.score != null, orElse: () => _Round('', ''));
    final waiting = chosen == null && rounds.lastOrNull?.score == null && !s.done;
    final tool = active == null ? 0 : (active.text ? 7 : (active.w >= (xcf?.width ?? 1080) && active.h >= (xcf?.height ?? 1350) ? 4 : 0));
    final status = s.work.lastOrNull ?? '';
    return Container(
      decoration: BoxDecoration(color: _G.window, borderRadius: BorderRadius.circular(10), border: Border.all(color: _G.edge)),
      clipBehavior: Clip.antiAlias,
      child: DefaultTextStyle(
        style: GoogleFonts.inter(fontSize: 12, color: _G.text),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // The open images: one tab per slide of the set.
          Container(
            height: 62,
            padding: const EdgeInsets.fromLTRB(46, 6, 8, 0),
            decoration: const BoxDecoration(color: _G.bar, border: Border(bottom: BorderSide(color: _G.edge))),
            child: Row(children: [
              Expanded(
                child: ListView(scrollDirection: Axis.horizontal, children: [
                  for (final n in widget.view.order)
                    _ImageTab(slide: widget.view.slides[n]!, selected: n == s.n, onTap: () => widget.onPin(n)),
                ]),
              ),
              if (widget.pinned)
                TextButton.icon(
                  onPressed: () => widget.onPin(null),
                  icon: const Icon(Icons.my_location_rounded, size: 14),
                  label: const Text('Follow the designer', style: TextStyle(fontSize: 12)),
                ),
            ]),
          ),
          Expanded(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              _Toolbox(active: tool),
              Expanded(
                child: _Canvas(
                  image: image,
                  xcf: xcf,
                  layer: active,
                  pointer: _pointerOf(widget.view, widget.busy),
                  onLayerTap: tapLayer,
                  say: _pointerOf(widget.view, widget.busy) == null ? null : widget.view.said[_pointerOf(widget.view, widget.busy)!.key]?.event.text.split('\n').first,
                  stamp: _stampOf(s, roundShown, chosen != null),
                  onOpen: image == null || image.isEmpty ? null : () => showBig(context, NetworkImage(Api.fileUrl(image)), caption: 'Slide ${s.n}'),
                ),
              ),
              SizedBox(
                width: 290,
                child: Container(
                  decoration: const BoxDecoration(color: _G.dock, border: Border(left: BorderSide(color: _G.edge))),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    // Layers of the slide, or the run's photos to swap the slide's.
                    Container(
                      height: 30,
                      decoration: const BoxDecoration(color: _G.bar, border: Border(bottom: BorderSide(color: _G.edge), top: BorderSide(color: _G.edge))),
                      child: Row(children: [
                        for (final (photo, icon, label) in [(false, Icons.layers_outlined, 'Layers'), (true, Icons.photo_library_outlined, 'Photos · ${allPhotos.length}')])
                          InkWell(
                            onTap: () => setState(() => photosTab = photo),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: photosTab == photo ? _G.boundary : Colors.transparent, width: 2))),
                              child: Row(children: [
                                Icon(icon, size: 14, color: photosTab == photo ? _G.text : _G.dim),
                                const SizedBox(width: 6),
                                Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: photosTab == photo ? _G.text : _G.dim)),
                              ]),
                            ),
                          ),
                      ]),
                    ),
                    if (photosTab)
                      SizedBox(
                        height: 300,
                        child: allPhotos.isEmpty
                            ? const Center(child: Text('The photos show once the analyst reads the website.', textAlign: TextAlign.center, style: TextStyle(color: _G.dim, fontSize: 11.5)))
                            : GridView.builder(
                                padding: const EdgeInsets.all(8),
                                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 90, mainAxisSpacing: 6, crossAxisSpacing: 6, childAspectRatio: 0.8),
                                itemCount: allPhotos.length,
                                itemBuilder: (context, i) => _PhotoTile(
                                  photo: allPhotos[i],
                                  current: allPhotos[i].id == slidePhotos[s.n],
                                  onTap: () => allPhotos[i].id == slidePhotos[s.n] ? null : send('Use photo ${allPhotos[i].id} on this slide instead of the current photo.'),
                                ),
                              ),
                      )
                    else
                    SizedBox(
                      height: 30.0 * (layers.isEmpty ? 2 : layers.length.clamp(3, 9)) + 4,
                      child: layers.isEmpty
                          ? const Center(child: Text('The layers show once the slide is saved.', style: TextStyle(color: _G.dim, fontSize: 11.5)))
                          : ListView.builder(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              itemCount: layers.length,
                              itemBuilder: (context, i) => _LayerRow(
                                layer: layers[i],
                                selected: i == current,
                                onHover: (on) => setState(() => hover = on ? i : null),
                                onTap: () {
                                  assemble?.cancel();
                                  setState(() => layer = i);
                                },
                              ),
                            ),
                    ),
                    _DockTab(icon: Icons.gavel_rounded, title: 'Critic', color: _colorOf('critic')),
                    Expanded(
                      child: _CriticDock(
                        slide: s,
                        judged: judged.score == null ? null : judged,
                        waiting: waiting,
                        chosen: chosen,
                        onRound: (i) => widget.onPin(s.n, i),
                      ),
                    ),
                  ]),
                ),
              ),
            ]),
          ),
          // Status bar: units, zoom, the layer and what GIMP last did.
          Container(
            height: 24,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(color: _G.bar, border: Border(top: BorderSide(color: _G.edge))),
            child: Row(children: [
              const Text('px ▾', style: TextStyle(fontSize: 11, color: _G.dim)),
              const SizedBox(width: 16),
              if (active != null) Text('${active.name} (${active.w}×${active.h})', style: const TextStyle(fontSize: 11, color: _G.dim)),
              const SizedBox(width: 16),
              Expanded(child: Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: _G.dim))),
            ]),
          ),
        ]),
      ),
    );
  }

  Future<void> loadPhotos() async {
    try {
      final (list, used) = await _runPhotos(widget.runId);
      if (!mounted) return;
      setState(() {
        photos = list;
        slidePhotos = used;
      });
    } catch (_) {}
  }

  // The run's photos, cutouts included, and every other image from the website.
  List<_RunPhoto> get allPhotos => _websiteChoices(photos, widget.view.site, cutouts: true);

  void tell(String text) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 4)));

  Future<void> send(String feedback) async {
    if (!widget.canEdit) {
      tell('You can change the slides once the carousel is ready and GIMP is free (pause the queue).');
      return;
    }
    final failed = await widget.onEdit(widget.slide.n, feedback);
    tell(failed ?? 'Sent to the designer: it rebuilds slide ${widget.slide.n} in GIMP.');
    if (failed == null) Future.delayed(const Duration(seconds: 20), loadPhotos);
  }

  // A click on the slide: a text opens its words, the photo opens the run's photos.
  void tapLayer(_Layer l) {
    final i = xcf?.layers.indexOf(l) ?? -1;
    if (i >= 0) {
      assemble?.cancel();
      setState(() => layer = i);
    }
    if (l.text) {
      editText(l);
    } else if (RegExp('photo|product|cut', caseSensitive: false).hasMatch(l.name)) {
      pickPhoto();
    }
  }

  Future<void> editText(_Layer l) async {
    final field = switch (l.name.toLowerCase()) {
      'headline' => 'headline',
      'body' => 'body',
      'button text' => 'button',
      'eyebrow' || 'label' => 'eyebrow',
      _ => l.name.toLowerCase(),
    };
    final plan = (widget.view.plan?['slides'] as List?)?.whereType<Map>().where((x) => x['n'] == widget.slide.n).firstOrNull;
    final controller = TextEditingController(text: '${plan?[field] ?? ''}');
    final text = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        titlePadding: EdgeInsets.zero,
        title: _DialogHeader(kicker: 'SLIDE ${widget.slide.n.toString().padLeft(2, '0')} · ${field.toUpperCase()}', title: 'Change the ${field == 'button' ? 'button' : field}', text: 'The designer rebuilds the slide in GIMP with your words, exactly as you write them.'),
        content: SizedBox(
          width: 480,
          child: TextField(controller: controller, autofocus: true, maxLines: 4, minLines: 2, style: const TextStyle(fontSize: 15, color: _C.text, height: 1.4)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton.icon(onPressed: () => Navigator.pop(context, controller.text.trim()), icon: const Icon(Icons.send_rounded, size: 18), label: const Text('Send to the designer')),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    await send('Change the $field to exactly: "$text"');
  }

  Future<void> pickPhoto() async {
    if (photos.isEmpty) await loadPhotos();
    if (!mounted) return;
    final current = slidePhotos[widget.slide.n];
    final id = await _pickPhotoDialog(context, slide: widget.slide.n, choices: allPhotos, current: current, host: _hostOf(widget.view.url));
    if (id == null || id == current) return;
    await send('Use photo $id on this slide instead of the current photo.');
  }

  // Whose hand is on the canvas: the designer builds, the fixer rebuilds, the critic looks.
  static _Agent? _pointerOf(_View v, bool busy) {
    if (!busy) return null;
    final who = v.active == 'fixer' || v.active == 'critic' || v.active == 'art' ? v.active! : 'designer';
    return _agent(who);
  }

  static (String, Color)? _stampOf(_Slide s, _Round? r, bool chosen) {
    if (r?.score != null) return ('${r!.approved == true ? 'Approved' : 'Rejected'} · ${r.score}/10', r.approved == true ? _C.ok : _C.bad);
    if (chosen) return null;
    if (s.done) return s.approved == true ? ('Approved', _C.ok) : ('Kept', _C.warn);
    return ('The critic is looking', _colorOf('critic'));
  }
}

class _ImageTab extends StatelessWidget {
  const _ImageTab({required this.slide, required this.selected, required this.onTap});
  final _Slide slide;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final last = slide.rounds.lastOrNull;
    final color = slide.done
        ? (slide.approved == true ? _C.ok : _C.warn)
        : last == null
            ? _G.dim
            : last.approved == false
                ? _C.bad
                : _C.violet;
    return InkWell(
      onTap: onTap,
      child: Container(
        width: 54,
        margin: const EdgeInsets.only(right: 2),
        padding: const EdgeInsets.fromLTRB(5, 3, 5, 0),
        decoration: BoxDecoration(
          color: selected ? _G.window : Colors.transparent,
          border: Border(bottom: BorderSide(color: selected ? _G.boundary : color, width: 2)),
        ),
        child: Column(children: [
          SizedBox(
            width: 36,
            height: 45,
            child: Stack(clipBehavior: Clip.none, children: [
              Positioned.fill(
                child: slide.url == null || slide.url!.isEmpty
                    ? Container(color: _G.canvas, alignment: Alignment.center, child: Text('${slide.n}', style: const TextStyle(color: _G.dim, fontSize: 12)))
                    : _Net(slide.url!, fit: BoxFit.cover),
              ),
              if (slide.done && slide.approved == true)
                Positioned(
                  right: -6,
                  top: -5,
                  child: Container(
                    width: 16,
                    height: 16,
                    decoration: BoxDecoration(color: _C.ok, shape: BoxShape.circle, border: Border.all(color: _G.bar, width: 2)),
                    child: const Icon(Icons.check_rounded, size: 10, color: Colors.white),
                  ),
                ),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Toolbox extends StatelessWidget {
  const _Toolbox({required this.active});
  final int active;

  static const tools = [
    (Icons.open_with_rounded, 'Move'),
    (Icons.highlight_alt_rounded, 'Rectangle Select'),
    (Icons.gesture_rounded, 'Free Select'),
    (Icons.crop_rounded, 'Crop'),
    (Icons.format_color_fill_rounded, 'Bucket Fill'),
    (Icons.gradient_rounded, 'Gradient'),
    (Icons.brush_rounded, 'Paintbrush'),
    (Icons.text_fields_rounded, 'Text'),
    (Icons.colorize_rounded, 'Color Picker'),
    (Icons.zoom_in_rounded, 'Zoom'),
  ];

  @override
  Widget build(BuildContext context) => Container(
        width: 40,
        padding: const EdgeInsets.only(top: 6),
        decoration: const BoxDecoration(color: _G.dock, border: Border(right: BorderSide(color: _G.edge))),
        child: Column(children: [
          for (var i = 0; i < tools.length; i++)
            Tooltip(
              message: tools[i].$2,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: 30,
                height: 30,
                margin: const EdgeInsets.only(bottom: 2),
                decoration: BoxDecoration(color: i == active ? _G.selected : Colors.transparent, borderRadius: BorderRadius.circular(4)),
                child: Icon(tools[i].$1, size: 17, color: i == active ? Colors.white : _G.dim),
              ),
            ),
          const Spacer(),
          // Foreground and background colors, as in GIMP's toolbox.
          SizedBox(
            width: 30,
            height: 30,
            child: Stack(children: [
              Positioned(right: 0, bottom: 0, child: Container(width: 17, height: 17, decoration: BoxDecoration(color: Colors.white, border: Border.all(color: _G.edge)))),
              Positioned(left: 0, top: 0, child: Container(width: 17, height: 17, decoration: BoxDecoration(color: Colors.black, border: Border.all(color: _G.dim)))),
            ]),
          ),
          const SizedBox(height: 10),
        ]),
      );
}

// The image on GIMP's canvas with its rulers, and the boundary of the layer in focus.
class _Canvas extends StatelessWidget {
  const _Canvas({required this.image, required this.xcf, required this.layer, required this.stamp, required this.onOpen, this.pointer, this.say, this.onLayerTap});
  // A click on a layer of the slide: the topmost one under the pointer.
  final void Function(_Layer)? onLayerTap;
  // What the agent at work says while it edits.
  final String? say;
  // The agent at work, drawn as a mouse pointer on the layer it is touching.
  final _Agent? pointer;
  final String? image;
  final _Xcf? xcf;
  final _Layer? layer;
  final (String, Color)? stamp;
  final VoidCallback? onOpen;

  static const ruler = 18.0;

  @override
  Widget build(BuildContext context) {
    final w = (xcf?.width ?? 1080).toDouble();
    final h = (xcf?.height ?? 1350).toDouble();
    return LayoutBuilder(builder: (context, c) {
      final room = Size(c.maxWidth - ruler - 48, c.maxHeight - ruler - 56);
      final scale = (room.width / w).clamp(0.0, room.height / h);
      final rect = Rect.fromLTWH(ruler + (c.maxWidth - ruler - w * scale) / 2, ruler + (c.maxHeight - ruler - h * scale) / 2 + 8, w * scale, h * scale);
      final l = layer;
      return Stack(children: [
        const Positioned.fill(child: ColoredBox(color: _G.canvas)),
        Positioned.fromRect(
          rect: rect,
          child: GestureDetector(
            onTapUp: (d) {
              final x = d.localPosition.dx / scale;
              final y = d.localPosition.dy / scale;
              final hit = xcf?.layers.where((l) => !(l.w >= w - 1 && l.h >= h - 1) && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h).firstOrNull;
              if (hit != null && onLayerTap != null) {
                onLayerTap!(hit);
              } else {
                onOpen?.call();
              }
            },
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 350),
              child: image == null || image!.isEmpty
                  ? const _Blink(child: ColoredBox(color: _G.ruler))
                  : _Net(image!, key: ValueKey(image), fit: BoxFit.fill),
            ),
          ),
        ),
        if (l != null)
          Positioned.fromRect(
            rect: Rect.fromLTWH(rect.left + l.x * scale, rect.top + l.y * scale, l.w * scale, l.h * scale).intersect(rect.inflate(2)),
            child: IgnorePointer(child: CustomPaint(painter: _Dashed())),
          ),
        // The layer in focus says what it is, like a labeled pin on a diagram.
        if (l != null && !(l.w >= w - 1 && l.h >= h - 1))
          Positioned(
            left: (rect.left + l.x * scale).clamp(rect.left, rect.right - 90),
            top: (rect.top + l.y * scale - 26).clamp(rect.top - 26, rect.bottom - 26),
            child: IgnorePointer(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(color: const Color(0xFF2F6FED), borderRadius: BorderRadius.circular(20), border: Border.all(color: Colors.white, width: 1.5)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(l.text ? Icons.text_fields_rounded : Icons.image_outlined, size: 12, color: Colors.white),
                  const SizedBox(width: 4),
                  Text(l.name, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Colors.white)),
                ]),
              ),
            ),
          ),
        if (pointer != null && l != null)
          AnimatedPositioned(
            duration: const Duration(milliseconds: 650),
            curve: Curves.easeInOutCubic,
            left: (rect.left + (l.x + l.w * 0.55) * scale).clamp(rect.left, rect.right - 20),
            top: (rect.top + (l.y + l.h * 0.45) * scale).clamp(rect.top, rect.bottom - 20),
            child: IgnorePointer(child: _Pointer(agent: pointer!, say: say)),
          ),
        if (stamp != null)
          Positioned(
            left: rect.left,
            top: rect.top - 30,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
              decoration: BoxDecoration(color: stamp!.$2, borderRadius: BorderRadius.circular(4)),
              child: Text(stamp!.$1.toUpperCase(), style: mono(size: 11, color: Colors.white, weight: FontWeight.w800, spacing: 0.4)),
            ),
          ),
        Positioned(
          right: 10,
          bottom: 8,
          child: Text('${(scale * 100).round()}%', style: const TextStyle(fontSize: 11, color: _G.dim)),
        ),
        // Guides: the 80 px margins and the center, so what is centered or aligned shows it.
        Positioned.fromRect(rect: rect, child: IgnorePointer(child: CustomPaint(painter: _Guides(w, h)))),
        Positioned(left: ruler, right: 0, top: 0, height: ruler, child: CustomPaint(painter: _Ruler(start: rect.left - ruler, scale: scale, size: w))),
        Positioned(left: 0, top: ruler, bottom: 0, width: ruler, child: CustomPaint(painter: _Ruler(start: rect.top - ruler, scale: scale, size: h, vertical: true))),
        const Positioned(left: 0, top: 0, width: ruler, height: ruler, child: ColoredBox(color: _G.ruler)),
      ]);
    });
  }
}

class _Ruler extends CustomPainter {
  _Ruler({required this.start, required this.scale, required this.size, this.vertical = false});
  final double start;
  final double scale;
  final double size;
  final bool vertical;

  @override
  void paint(Canvas canvas, Size box) {
    canvas.drawRect(Offset.zero & box, Paint()..color = _G.ruler);
    final tick = Paint()
      ..color = _G.dim
      ..strokeWidth = 1;
    final length = vertical ? box.width : box.height;
    final span = vertical ? box.height : box.width;
    for (var px = -1000.0; px <= size + 1000; px += 50) {
      final at = start + px * scale;
      if (at < 0 || at > span) continue;
      final major = px % 250 == 0;
      final t = major ? length : length * 0.35;
      if (vertical) {
        canvas.drawLine(Offset(box.width - t, at), Offset(box.width, at), tick);
      } else {
        canvas.drawLine(Offset(at, box.height - t), Offset(at, box.height), tick);
      }
      if (major) {
        final label = TextPainter(
          text: TextSpan(text: '${px.round()}', style: const TextStyle(fontSize: 8, color: _G.dim)),
          textDirection: TextDirection.ltr,
        )..layout();
        if (vertical) {
          canvas.save();
          canvas.translate(2, at + 2 + label.width);
          canvas.rotate(-1.5708);
          label.paint(canvas, Offset.zero);
          canvas.restore();
        } else {
          label.paint(canvas, Offset(at + 2, 1));
        }
      }
    }
  }

  @override
  bool shouldRepaint(_Ruler old) => old.start != start || old.scale != scale;
}

// GIMP's layer boundary: a yellow and black dashed line.
class _Dashed extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final black = Paint()
      ..color = Colors.black
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;
    final yellow = Paint()
      ..color = _G.boundary
      ..strokeWidth = 1.5;
    canvas.drawRect(Offset.zero & size, black);
    void dash(Offset a, Offset b) {
      final d = b - a;
      final len = d.distance;
      for (var t = 0.0; t < len; t += 8) {
        canvas.drawLine(a + d * (t / len), a + d * ((t + 4).clamp(0, len) / len), yellow);
      }
    }

    dash(Offset.zero, Offset(size.width, 0));
    dash(Offset(size.width, 0), Offset(size.width, size.height));
    dash(Offset(size.width, size.height), Offset(0, size.height));
    dash(Offset(0, size.height), Offset.zero);
  }

  @override
  bool shouldRepaint(_Dashed old) => false;
}

class _DockTab extends StatelessWidget {
  const _DockTab({required this.icon, required this.title, this.color});
  final IconData icon;
  final String title;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: const BoxDecoration(color: _G.bar, border: Border(bottom: BorderSide(color: _G.edge), top: BorderSide(color: _G.edge))),
        child: Row(children: [
          Icon(icon, size: 14, color: color ?? _G.text),
          const SizedBox(width: 6),
          Text(title, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: color ?? _G.text)),
        ]),
      );
}

class _LayerRow extends StatelessWidget {
  const _LayerRow({required this.layer, required this.selected, required this.onHover, required this.onTap});
  final _Layer layer;
  final bool selected;
  final void Function(bool) onHover;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => MouseRegion(
        onEnter: (_) => onHover(true),
        onExit: (_) => onHover(false),
        child: GestureDetector(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            height: 30,
            color: selected ? _G.selected : Colors.transparent,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              Icon(layer.visible ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 14, color: _G.dim),
              const SizedBox(width: 8),
              Container(
                width: 26,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: _G.canvas, border: Border.all(color: _G.edge)),
                child: layer.text
                    ? const Text('T', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: _G.text))
                    : const Icon(Icons.image_outlined, size: 13, color: _G.dim),
              ),
              const SizedBox(width: 8),
              Expanded(child: Text(layer.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12))),
              Text('${layer.w}×${layer.h}', style: const TextStyle(fontSize: 10, color: _G.dim)),
            ]),
          ),
        ),
      );
}

// The critic as a GIMP dock: the rounds, the score and what has to change.
class _CriticDock extends StatelessWidget {
  const _CriticDock({required this.slide, required this.judged, required this.waiting, required this.chosen, required this.onRound});
  final _Slide slide;
  final _Round? judged;
  final bool waiting;
  final int? chosen;
  final void Function(int) onRound;

  @override
  Widget build(BuildContext context) {
    final critic = _agent('critic')!;
    final r = judged;
    return ListView(padding: const EdgeInsets.all(10), children: [
      Row(children: [
        for (var i = 0; i < slide.rounds.length; i++) ...[
          if (i > 0) const Padding(padding: EdgeInsets.symmetric(horizontal: 3), child: Icon(Icons.arrow_forward_rounded, size: 13, color: _G.dim)),
          _RoundChip(round: slide.rounds[i], selected: chosen == i, onTap: () => onRound(i)),
        ],
      ]),
      const SizedBox(height: 10),
      if (waiting && (r == null || r == slide.rounds.lastOrNull))
        Row(children: [
          _Avatar(agent: critic, working: true, idle: false, size: 22),
          const SizedBox(width: 8),
          Expanded(child: Text('Looking at slide ${slide.n}…', style: const TextStyle(color: _G.dim, fontSize: 12))),
        ])
      else if (r == null)
        const Text('Not judged yet.', style: TextStyle(color: _G.dim, fontSize: 12))
      else ...[
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('${r.score}', style: mono(size: 34, color: r.approved == true ? _C.ok : _C.bad, weight: FontWeight.w800)),
          Padding(padding: const EdgeInsets.only(bottom: 7), child: Text('/10  ${r.label}', style: mono(size: 12, color: _G.dim))),
        ]),
        // The checklist, as the critic answered it: green when it passes.
        for (final (check, answer, note) in r.checks)
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 16,
                height: 16,
                margin: const EdgeInsets.only(top: 1),
                decoration: BoxDecoration(shape: BoxShape.circle, color: answer == 'no' ? _C.bad : (answer == 'yes' ? _C.ok : _G.edge)),
                child: Icon(answer == 'no' ? Icons.close_rounded : (answer == 'yes' ? Icons.check_rounded : Icons.remove_rounded), size: 11, color: Colors.white),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_pretty(check), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: answer == 'no' ? _C.bad : _G.text)),
                  if (answer == 'no' && note.isNotEmpty) Text(note, style: const TextStyle(fontSize: 11.5, height: 1.35, color: _G.dim)),
                ]),
              ),
            ]),
          ),
        if (r.checks.isEmpty)
          for (final (check, note) in r.fails)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('✕ ${_pretty(check)}: $note', style: const TextStyle(fontSize: 12, height: 1.35, color: _C.bad)),
            ),
        if (r.fixes.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text('FOR THE FIXER', style: mono(size: 10.5, color: _colorOf('fixer'), weight: FontWeight.w800, spacing: 0.3)),
          for (final (fix, why) in r.fixes)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: '$fix  ', style: mono(size: 11, color: _colorOf('fixer'), weight: FontWeight.w700)),
                  TextSpan(text: why, style: const TextStyle(fontSize: 12, color: _G.dim)),
                ]),
              ),
            ),
        ],
        if (r.approved == true && r.fails.isEmpty) const Padding(padding: EdgeInsets.only(top: 6), child: Text('Every check passed.', style: TextStyle(color: _G.dim))),
      ],
    ]);
  }
}

class _RoundChip extends StatelessWidget {
  const _RoundChip({required this.round, required this.selected, required this.onTap});
  final _Round round;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = round.approved == null ? _G.dim : (round.approved! ? _C.ok : _C.bad);
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(border: Border.all(color: selected ? _G.boundary : color.withValues(alpha: 0.6)), borderRadius: BorderRadius.circular(4)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          SizedBox(width: 28, height: 35, child: round.url.isEmpty ? const SizedBox() : _Net(round.url, fit: BoxFit.cover)),
          const SizedBox(width: 5),
          Text(round.score == null ? '…' : '${round.score}', style: mono(size: 12, color: color, weight: FontWeight.w800)),
          const SizedBox(width: 3),
        ]),
      ),
    );
  }
}


class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.child, this.trailing});
  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(color: _C.panel, borderRadius: BorderRadius.circular(12), border: Border.all(color: _C.line)),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            height: 42,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: _C.line))),
            child: Row(children: [
              Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13))),
              ?trailing,
            ]),
          ),
          Expanded(child: child),
        ]),
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.color, required this.title, required this.text, this.blink = false});
  final IconData icon;
  final Color color;
  final String title;
  final String text;
  final bool blink;

  @override
  Widget build(BuildContext context) {
    final mark = Icon(icon, size: 36, color: color);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          blink ? _Blink(child: mark) : mark,
          const SizedBox(height: 12),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          Text(text, textAlign: TextAlign.center, maxLines: 6, overflow: TextOverflow.ellipsis, style: const TextStyle(color: _C.muted, height: 1.45)),
        ]),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color, this.blink = false});
  final String text;
  final Color color;
  final bool blink;

  @override
  Widget build(BuildContext context) {
    final dot = Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20), border: Border.all(color: color.withValues(alpha: 0.5))),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        blink ? _Blink(child: dot) : dot,
        const SizedBox(width: 6),
        Text(text, style: mono(size: 11, color: color, weight: FontWeight.w800)),
      ]),
    );
  }
}

class _Blink extends StatefulWidget {
  const _Blink({required this.child});
  final Widget child;

  @override
  State<_Blink> createState() => _BlinkState();
}

class _BlinkState extends State<_Blink> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: Tween(begin: 0.45, end: 1.0).animate(c), child: widget.child);
}

class _Net extends StatelessWidget {
  const _Net(this.path, {super.key, this.fit = BoxFit.cover});
  final String path;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) => Image.network(
        Api.fileUrl(path),
        fit: fit,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => const ColoredBox(color: _G.ruler),
      );
}

Color _hex(String hex) {
  final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
  return v == null ? _C.raised : Color(0xFF000000 | v);
}


// Where the run is, one step at a time: a segmented bar, the step in a big title, what
// happens in it in plain words and a tip of what to look at.
class _Progress extends StatelessWidget {
  const _Progress({required this.view});
  final _View view;

  static const carousel = ['Read the website', 'Plan', 'Art direction', 'Design in GIMP', 'Review', 'Ready'];
  static const withReel = ['Read the website', 'Plan', 'Art direction', 'Design in GIMP', 'Review', 'Reel', 'Ready'];

  static const about = {
    'Read the website': (
      'The analyst opens the business\'s website and keeps only what is real: the logo, the brand colors and the photos.',
      'Nothing is invented: every photo on the slides comes from the website.',
    ),
    'Plan': ('The director picks the format and writes each slide with facts from the website.', 'Slide 1 is the hook; the last slide asks for one action.'),
    'Art direction': (
      'The art director sets the fonts, the colors and the ground, different from the last brands it designed.',
      'Muse Wonder decides the look; Muse Image paints the decor.',
    ),
    'Design in GIMP': (
      'The designer builds each slide in GIMP, layer by layer, and the critic checks it before it moves on.',
      'The pointer is the agent at work. Click a text or the photo to change it.',
    ),
    'Review': ('The critic looks at the whole set: one family, and every photo showing what its words say.', 'A slide that doesn\'t fit goes back to the designer.'),
    'Reel': ('The designer turns the carousel into a 30 s reel in HyperFrames; the critic checks it shot by shot.', 'Turn on Safe areas to see what Instagram\'s buttons cover.'),
    'Ready': ('Your carousel is ready. Write to the director in the team chat to change anything.', 'Open Preview to see it as it will show in the feed.'),
  };

  @override
  Widget build(BuildContext context) {
    final v = view;
    final slides = v.slides.values.toList();
    final total = slides.length;
    final done = slides.where((s) => s.done).length;
    final steps = v.reelPhase ? withReel : carousel;
    final step = v.finished
        ? steps.length - 1
        : v.reelPhase
            ? 5
            : v.site == null
                ? 0
                : v.plan == null
                    ? 1
                    : !v.building
                        ? 2
                        : done < total
                            ? 3
                            : 4;
    final part = total == 0 ? 0.0 : slides.map((s) => s.done ? 1.0 : (s.rounds.isNotEmpty ? 0.5 : 0.0)).reduce((a, b) => a + b) / total;
    final shotsJudged = v.reelShots == null || v.reelShots!.isEmpty ? 0.0 : v.reelVerdicts.length / v.reelShots!.length;
    final reading = (0.02 + 0.025 * (v.talks['analyst'] ?? 0)).clamp(0.02, 0.12);
    final styling = (0.18 + 0.025 * (v.talks['art'] ?? 0)).clamp(0.18, 0.28);
    final value = v.finished ? 1.0 : (v.reelPhase ? 0.9 + 0.08 * shotsJudged : [reading, 0.15, styling, 0.3 + 0.55 * part, 0.93][step]);
    final now = v.error != null
        ? 'The run stopped'
        : switch (step) {
            0 when v.pickUntil != null => 'Your turn: pick the images the agents can use',
            0 => 'The analyst is reading your website',
            1 => 'The director is planning the story',
            2 when v.planUntil != null => 'Your turn: review the director\'s plan',
            2 => 'The art director is choosing the look',
            3 => 'Designing slide ${v.focus ?? done + 1} of $total in GIMP',
            4 => 'The critic is checking the whole set',
            5 when v.reelPhase && !v.finished => v.reelVerdicts.isNotEmpty
                ? 'The critic is checking the reel shot by shot'
                : v.reelShots == null
                    ? 'The director is planning the 30 s reel'
                    : 'Making the 30 s reel in HyperFrames${v.reelRound > 0 ? ' (round ${v.reelRound + 1})' : ''}',
            _ => v.reelPhase ? 'Your carousel and its reel are ready' : 'Your carousel is ready',
          };
    final color = v.error != null ? _C.bad : (v.finished ? _C.ok : _C.violet);
    final what = (about[steps[step]] ?? ('', '')).$1;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 16),
      decoration: const BoxDecoration(color: _C.panel, border: Border(bottom: BorderSide(color: _C.line))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // One segment per step: done, now, still to come.
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < steps.length; i++)
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(right: i == steps.length - 1 ? 0 : 6),
                child: Column(crossAxisAlignment: CrossAxisAlignment.center, children: [
                  Container(
                    height: 5,
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(3), color: _C.line),
                    child: i < step || v.finished
                        ? DecoratedBox(decoration: BoxDecoration(borderRadius: BorderRadius.circular(3), color: color))
                        : i == step
                            ? _Blink(child: DecoratedBox(decoration: BoxDecoration(borderRadius: BorderRadius.circular(3), color: color.withValues(alpha: 0.55))))
                            : null,
                  ),
                  const SizedBox(height: 7),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    if (i < step || v.finished) Icon(Icons.check_circle_rounded, size: 14, color: color),
                    if (i == step && !v.finished) _Blink(child: Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle))),
                    const SizedBox(width: 5),
                    Flexible(
                      child: Text(
                        '${i + 1}. ${steps[i]}${i == step && !v.finished ? ' · now' : ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, fontWeight: i == step ? FontWeight.w800 : FontWeight.w600, color: i == step ? color : (i < step || v.finished ? _C.text : _C.faint)),
                      ),
                    ),
                  ]),
                ]),
              ),
            ),
        ]),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text('STEP ${step + 1} OF ${steps.length} · ${steps[step].toUpperCase()}', style: mono(size: 11, color: color, weight: FontWeight.w800, spacing: 0.6)),
                const SizedBox(width: 10),
                Text('${(value * 100).round()}%', style: mono(size: 11, color: _C.faint, weight: FontWeight.w700)),
              ]),
              const SizedBox(height: 6),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                child: Text(now, key: ValueKey(now), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.3, height: 1.2)),
              ),
              const SizedBox(height: 4),
              Text(what, style: const TextStyle(fontSize: 13.5, height: 1.45, color: _C.muted)),
            ]),
          ),
        ]),
      ]),
    );
  }
}

// Normal (Create) or edit view (this room), the same switch on both screens.
class ViewSwitch extends StatelessWidget {
  const ViewSwitch({super.key, required this.edit, required this.onChanged});
  final bool edit;
  final void Function(bool) onChanged;

  @override
  Widget build(BuildContext context) {
    Widget option(bool value, IconData icon, String label) {
      final on = edit == value;
      return InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => onChanged(value),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(color: on ? _C.violet.withValues(alpha: 0.18) : Colors.transparent, borderRadius: BorderRadius.circular(8)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 15, color: on ? _C.text : _C.muted),
            const SizedBox(width: 6),
            Text(label, style: TextStyle(fontSize: 12.5, fontWeight: on ? FontWeight.w800 : FontWeight.w500, color: on ? _C.text : _C.muted)),
          ]),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: _C.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        option(false, Icons.crop_portrait_rounded, 'Normal'),
        option(true, Icons.layers_outlined, 'Edit view'),
      ]),
    );
  }
}


// One shot of the reel as the timeline draws it.
class _ReelShot {
  _ReelShot.fromJson(Map j)
      : start = (j['start'] as num?)?.toDouble() ?? 0,
        end = (j['end'] as num?)?.toDouble() ?? 0,
        layout = '${j['layout'] ?? ''}',
        text = '${j['text'] ?? ''}',
        photo = j['photo'] as String?,
        camera = '${j['camera'] ?? ''}',
        transition = '${j['transition'] ?? ''}',
        textScale = (j['textScale'] as num?)?.toDouble();
  final double start;
  final double end;
  final String layout;
  final String text;
  final String? photo;
  final String camera;
  final String transition;
  final double? textScale;
}

class _Tab extends StatelessWidget {
  const _Tab({required this.label, required this.icon, required this.on, required this.onTap});
  final String label;
  final IconData icon;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: on ? _C.violet.withValues(alpha: 0.1) : _C.panel,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: on ? _C.violet : _C.line),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 16, color: on ? _C.violet : _C.muted),
            const SizedBox(width: 6),
            Text(label, style: TextStyle(fontSize: 13, fontWeight: on ? FontWeight.w800 : FontWeight.w600, color: on ? _C.text : _C.muted)),
          ]),
        ),
      );
}

class _ShotVerdict extends StatelessWidget {
  const _ShotVerdict({required this.shot, required this.verdict, required this.set});
  final _ReelShot? shot;
  final Map<String, dynamic>? verdict;
  final Map<String, dynamic>? set;

  @override
  Widget build(BuildContext context) {
    final v = verdict;
    final checks = (v?['checks'] as Map?) ?? const {};
    final fails = [for (final e in checks.entries) if (e.value is Map && (e.value as Map)['answer'] == 'no') ('${e.key}', '${(e.value as Map)['note'] ?? ''}')];
    final fixes = [for (final f in (v?['fixes'] as List?) ?? const []) if (f is Map) ('${f['action']}', '${f['why'] ?? ''}')];
    final setChecks = (set?['checks'] as Map?) ?? const {};
    final approved = v?['approved'] == true;
    return ListView(padding: const EdgeInsets.all(10), children: [
      if (shot != null) ...[
        Text('${shot!.layout.replaceAll('_', ' ')} · ${shot!.start.toStringAsFixed(1)}–${shot!.end.toStringAsFixed(1)} s', style: mono(size: 10.5, color: _G.dim)),
        const SizedBox(height: 4),
        Text('"${shot!.text}"', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
      ],
      if (v == null)
        Row(children: [
          _Avatar(agent: _agent('critic')!, working: true, idle: false, size: 22),
          const SizedBox(width: 8),
          const Expanded(child: Text('The critic looks at every shot once it is rendered.', style: TextStyle(color: _G.dim, fontSize: 12))),
        ])
      else ...[
        if (v['url'] != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Center(child: SizedBox(height: 150, child: AspectRatio(aspectRatio: 9 / 16, child: _Net('${v['url']}', fit: BoxFit.cover)))),
          ),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('${v['score'] ?? '–'}', style: mono(size: 30, color: approved ? _C.ok : _C.bad, weight: FontWeight.w800)),
          Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('/10  ${approved ? 'approved' : 'rejected'}', style: mono(size: 12, color: _G.dim))),
        ]),
        for (final (check, note) in fails)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('✕ ${_pretty(check).toUpperCase()}', style: mono(size: 10.5, color: _C.bad, weight: FontWeight.w800, spacing: 0.3)),
              const SizedBox(height: 2),
              Text(note, style: const TextStyle(fontSize: 12, height: 1.35)),
            ]),
          ),
        if (fixes.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text('FOR THE FIXER', style: mono(size: 10.5, color: _colorOf('fixer'), weight: FontWeight.w800, spacing: 0.3)),
          for (final (fix, why) in fixes)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text.rich(TextSpan(children: [
                TextSpan(text: '$fix  ', style: mono(size: 11, color: _colorOf('fixer'), weight: FontWeight.w700)),
                TextSpan(text: why, style: const TextStyle(fontSize: 12, color: _G.dim)),
              ])),
            ),
        ],
      ],
      if (set != null) ...[
        const SizedBox(height: 14),
        Text('THE WHOLE REEL · ${set!['score'] ?? '–'}/10', style: mono(size: 10.5, color: _G.dim, weight: FontWeight.w800, spacing: 0.3)),
        for (final e in setChecks.entries)
          if (e.value is Map)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '${(e.value as Map)['answer'] == 'no' ? '✕' : '✓'} ${_pretty('${e.key}')}${(e.value as Map)['answer'] == 'no' ? ': ${(e.value as Map)['note'] ?? ''}' : ''}',
                style: TextStyle(fontSize: 11.5, color: (e.value as Map)['answer'] == 'no' ? _C.bad : _G.dim),
              ),
            ),
      ],
    ]);
  }
}

// One animation of the composition's GSAP timeline: what moves, when and how.
class _Tween {
  const _Tween(this.shot, this.target, this.start, this.duration, this.ease);
  final int? shot;
  final String target;
  final double start;
  final double duration;
  final String ease;
}

class _Clip {
  const _Clip(this.name, this.start, this.duration);
  final String name;
  final double start;
  final double duration;
}

class _Composition {
  const _Composition(this.tweens, this.audio);
  final List<_Tween> tweens;
  final List<_Clip> audio;
}

// The reel's index.html read like the slide's .xcf: every tl.to/fromTo/set of its
// timeline (selector, position, duration, ease) and every audio clip.
_Composition _readComposition(String html) {
  final tweens = <_Tween>[];
  for (final line in html.split('\n')) {
    final t = line.trim();
    final m = RegExp(r'^tl\.(fromTo|to|from|set)\("([^"]+)"').firstMatch(t);
    if (m == null) continue;
    final pos = RegExp(r',\s*([\d.]+)\)\s*;?$').firstMatch(t);
    if (pos == null) continue;
    final durations = RegExp(r'duration:\s*([\d.]+)').allMatches(t).toList();
    final ease = RegExp(r'ease:\s*"([^"]+)"').firstMatch(t)?[1] ?? (m[1] == 'set' ? 'set' : 'none');
    final selector = m[2]!;
    final shot = RegExp(r'^#s(\d+)\b').firstMatch(selector);
    tweens.add(_Tween(
      shot == null ? null : int.parse(shot[1]!) + 1,
      shot == null ? selector : selector.substring(shot[0]!.length).trim(),
      double.parse(pos[1]!),
      m[1] == 'set' || durations.isEmpty ? 0 : double.parse(durations.last[1]!),
      ease,
    ));
  }
  final audio = <_Clip>[];
  for (final tag in RegExp(r'<audio[^>]*>').allMatches(html)) {
    String? attr(String name) => RegExp('$name="([^"]*)"').firstMatch(tag[0]!)?[1];
    final start = double.tryParse(attr('data-start') ?? '');
    final duration = double.tryParse(attr('data-duration') ?? '');
    if (start == null || duration == null) continue;
    final src = (attr('src') ?? attr('id') ?? 'audio').split('/').last.replaceAll(RegExp(r'\.(mp3|wav|m4a)$'), '').replaceFirst('sfx-', '');
    audio.add(_Clip(src, start, duration));
  }
  return _Composition(tweens, audio);
}

const _elementNames = {
  'wi': 'Words',
  'w': 'Words',
  'mk': 'Highlight',
  'ground': 'Ground',
  'card': 'Card',
  'label': 'Label',
  'g': 'Grid photo',
  'r': 'Wall row',
  'wall': 'Photo wall',
  'deck': 'Deck',
  'photo': 'Photo',
  'pic': 'Photo',
  'logo': 'Logo',
  'btn': 'Button',
  'button': 'Button',
  'chip': 'Chip',
  'slab': 'Slab',
  'product': 'Product',
  'shadow': 'Shadow',
  'text': 'Text',
  'cta': 'Call to action',
  'gridw': 'Grid',
  'cshade': 'Card shade',
  'em': 'Key word',
};

String _elementName(String target) {
  if (target.isEmpty) return 'Shot (enters, leaves)';
  final parts = target.replaceAll(RegExp(r':not\([^)]*\)'), '').split(RegExp(r'\s+'));
  String one(String p) {
    final m = RegExp(r'^\.([a-z]+?)(\d*)$').firstMatch(p);
    if (m == null) return p.replaceAll('.', '');
    final base = _elementNames[m[1]] ?? m[1]!;
    return m[2]!.isEmpty ? base : '$base ${int.parse(m[2]!) + 1}';
  }

  if (parts.length == 1 || one(parts.last) == one(parts.first)) return one(parts.last);
  // The words of the key word are the key word.
  return parts.first == '.em' ? 'Key word' : '${one(parts.last)} · ${one(parts.first)}';
}

IconData _elementIcon(String target) {
  final t = target.split(RegExp(r'\s+')).last;
  if (RegExp(r'^\.(wi|w|mk|label\d*|text|btn|button|chip\d*|cta)$').hasMatch(t)) return Icons.text_fields_rounded;
  if (RegExp(r'^\.(photo|pic|card\d*|g\d+|r\d+|wall|product|deck|gridw)$').hasMatch(t)) return Icons.image_outlined;
  if (t.isEmpty) return Icons.movie_outlined;
  return Icons.crop_square_rounded;
}

// The reel in HyperFrames, as the slides are in GIMP: the composition's elements, the render
// with its playhead, the critic docked beside it, and the timeline with every animation.
class _ReelEditor extends StatefulWidget {
  const _ReelEditor({required this.runId, required this.view, required this.selected, required this.onSelect});
  final String runId;
  final _View view;
  final int? selected;
  final void Function(int?) onSelect;

  @override
  State<_ReelEditor> createState() => _ReelEditorState();
}

class _ReelEditorState extends State<_ReelEditor> {
  final playhead = ValueNotifier<double>(0);
  _Composition? comp;
  String? loaded;
  String? element;
  Timer? clock;
  // The Reels safe zone over the preview: what Instagram's own buttons and caption cover.
  bool safe = true;

  String? get videoUrl => widget.view.reelPreview;

  @override
  void initState() {
    super.initState();
    load();
    clock = Timer.periodic(const Duration(milliseconds: 100), (_) {
      final v = _ReelVideo.elements[videoUrl];
      if (v != null) playhead.value = v.currentTime.toDouble();
    });
  }

  @override
  void didUpdateWidget(_ReelEditor old) {
    super.didUpdateWidget(old);
    load();
  }

  @override
  void dispose() {
    clock?.cancel();
    playhead.dispose();
    super.dispose();
  }

  // The composition of the round on screen, read again when a new round is written.
  void load() {
    final key = '${widget.view.reelRound}-${widget.view.reelShots?.length}-${videoUrl ?? ''}';
    if (key == loaded) return;
    loaded = key;
    http.get(Uri.parse(Api.fileUrl('/files/${widget.runId}/motion/reel/index.html?v=$key'))).then((res) {
      if (!mounted || res.statusCode != 200) return;
      setState(() => comp = _readComposition(utf8.decode(res.bodyBytes)));
    }, onError: (_) {});
  }

  void seek(double t) {
    final v = _ReelVideo.elements[videoUrl];
    if (v != null) v.currentTime = t;
    playhead.value = t;
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.view;
    final shots = v.reelShots ?? const <_ReelShot>[];
    return ValueListenableBuilder<double>(
      valueListenable: playhead,
      builder: (context, t, _) {
        final under = shots.indexWhere((s) => t >= s.start && t < s.end) + 1;
        final pick = widget.selected != null && widget.selected! <= shots.length ? widget.selected! : (under > 0 ? under : 1);
        final shot = pick >= 1 && pick <= shots.length ? shots[pick - 1] : null;
        final tweens = (comp?.tweens ?? const <_Tween>[]).where((w) => w.shot == pick).toList();
        final targets = <String>[];
        for (final w in tweens) {
          if (!targets.contains(w.target)) targets.add(w.target);
        }
        String two(int n) => n.toString().padLeft(2, '0');
        final time = '${two(t ~/ 60)}:${two(t.floor() % 60)}.${two(((t - t.floor()) * 100).floor())}';
        return Container(
          decoration: BoxDecoration(color: _G.window, borderRadius: BorderRadius.circular(10), border: Border.all(color: _G.edge)),
          clipBehavior: Clip.antiAlias,
          child: DefaultTextStyle(
            style: GoogleFonts.inter(fontSize: 12, color: _G.text),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(
                child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  // Elements: what moves in this shot, read from the composition.
                  SizedBox(
                    width: 230,
                    child: Container(
                      decoration: const BoxDecoration(color: _G.dock, border: Border(right: BorderSide(color: _G.edge))),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        _DockTab(icon: Icons.layers_outlined, title: 'Elements · shot $pick'),
                        if (shot != null)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
                            child: Text('${shot.layout.replaceAll('_', ' ')} · ${shot.transition.replaceAll('_', ' ')} in · camera ${shot.camera.replaceAll('_', ' ')}', style: const TextStyle(fontSize: 11, color: _G.dim)),
                          ),
                        Expanded(
                          child: targets.isEmpty
                              ? const Center(child: Text('The elements show once the composition is written.', textAlign: TextAlign.center, style: TextStyle(color: _G.dim, fontSize: 11.5)))
                              : ListView(children: [
                                  for (final target in targets)
                                    MouseRegion(
                                      onEnter: (_) => setState(() => element = target),
                                      onExit: (_) => setState(() => element = null),
                                      child: Container(
                                        height: 28,
                                        color: element == target ? _G.selected : Colors.transparent,
                                        padding: const EdgeInsets.symmetric(horizontal: 10),
                                        child: Row(children: [
                                          Icon(_elementIcon(target), size: 14, color: _G.dim),
                                          const SizedBox(width: 8),
                                          Expanded(child: Text(_elementName(target), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12))),
                                          Text('${tweens.where((w) => w.target == target).length}', style: const TextStyle(fontSize: 10, color: _G.dim)),
                                        ]),
                                      ),
                                    ),
                                ]),
                        ),
                      ]),
                    ),
                  ),
                  Expanded(
                    child: ColoredBox(
                      color: _G.canvas,
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Center(
                          child: AspectRatio(
                            aspectRatio: 9 / 16,
                            child: Stack(fit: StackFit.expand, children: [
                              videoUrl != null
                                  ? _ReelVideo(url: videoUrl!, key: ValueKey(videoUrl))
                                  : v.reelVerdicts[pick]?['url'] != null
                                      ? _Net('${v.reelVerdicts[pick]!['url']}', fit: BoxFit.contain)
                                      : const _Blink(child: ColoredBox(color: _G.ruler, child: Center(child: Text('Rendering with HyperFrames…', style: TextStyle(color: _G.dim))))),
                              if (safe) const IgnorePointer(child: _SafeAreas()),
                              Positioned(
                                right: 6,
                                top: 6,
                                child: InkWell(
                                  onTap: () => setState(() => safe = !safe),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(color: safe ? _G.boundary : Colors.black54, borderRadius: BorderRadius.circular(5)),
                                    child: Text('Safe areas', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: safe ? Colors.black : Colors.white)),
                                  ),
                                ),
                              ),
                            ]),
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 290,
                    child: Container(
                      decoration: const BoxDecoration(color: _G.dock, border: Border(left: BorderSide(color: _G.edge))),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        _DockTab(icon: Icons.gavel_rounded, title: 'Critic · shot $pick', color: _colorOf('critic')),
                        Expanded(child: _ShotVerdict(shot: shot, verdict: v.reelVerdicts[pick], set: v.reelSet)),
                      ]),
                    ),
                  ),
                ]),
              ),
              _ReelTimeline(
                shots: shots,
                verdicts: v.reelVerdicts,
                pick: pick,
                tweens: tweens,
                targets: targets,
                element: element,
                audio: comp?.audio ?? const [],
                playhead: t,
                onSeek: seek,
                onPick: (n) {
                  widget.onSelect(n);
                  final s = shots[n - 1];
                  seek(s.start + (s.end - s.start) * 0.6);
                },
              ),
              Container(
                height: 24,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                decoration: const BoxDecoration(color: _G.bar, border: Border(top: BorderSide(color: _G.edge))),
                child: Row(children: [
                  Text('$time / 00:30.00', style: mono(size: 11, color: _G.text)),
                  const SizedBox(width: 16),
                  Text('shot $pick${shot != null ? ' · ${shot.layout.replaceAll('_', ' ')}' : ''}', style: const TextStyle(fontSize: 11, color: _G.dim)),
                  const SizedBox(width: 16),
                  Text('${tweens.length} animations in this shot', style: const TextStyle(fontSize: 11, color: _G.dim)),
                  const Spacer(),
                  if (widget.selected != null)
                    InkWell(onTap: () => widget.onSelect(null), child: const Text('Follow the playhead', style: TextStyle(fontSize: 11, color: _G.boundary))),
                ]),
              ),
            ]),
          ),
        );
      },
    );
  }
}

// The timeline: a ruler with the playhead, the shots, every animation of the shot picked
// (one row per element, a bar per tween) and the audio clips.
class _ReelTimeline extends StatelessWidget {
  const _ReelTimeline({
    required this.shots,
    required this.verdicts,
    required this.pick,
    required this.tweens,
    required this.targets,
    required this.element,
    required this.audio,
    required this.playhead,
    required this.onSeek,
    required this.onPick,
  });
  final List<_ReelShot> shots;
  final Map<int, Map<String, dynamic>> verdicts;
  final int pick;
  final List<_Tween> tweens;
  final List<String> targets;
  final String? element;
  final List<_Clip> audio;
  final double playhead;
  final void Function(double) onSeek;
  final void Function(int) onPick;

  static const label = 120.0;
  static const total = 30.0;

  @override
  Widget build(BuildContext context) {
    final rows = targets.take(7).toList();
    Widget row(String name, double height, Widget Function(double w) body, {IconData? icon, bool on = false}) => Container(
          height: height,
          color: on ? _G.selected.withValues(alpha: 0.35) : Colors.transparent,
          child: Row(children: [
            SizedBox(
              width: label,
              child: Padding(
                padding: const EdgeInsets.only(left: 8),
                child: Row(children: [
                  if (icon != null) ...[Icon(icon, size: 12, color: _G.dim), const SizedBox(width: 5)],
                  Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10.5, color: _G.dim))),
                ]),
              ),
            ),
            Expanded(child: LayoutBuilder(builder: (context, c) => body(c.maxWidth))),
          ]),
        );
    final shot = pick >= 1 && pick <= shots.length ? shots[pick - 1] : null;
    return Container(
      color: _G.bar,
      padding: const EdgeInsets.only(bottom: 6),
      child: Stack(children: [
        Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          row('', 22, (w) => GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (d) => onSeek((d.localPosition.dx / w * total).clamp(0, total)),
                onHorizontalDragUpdate: (d) => onSeek((d.localPosition.dx / w * total).clamp(0, total)),
                child: CustomPaint(size: Size(w, 22), painter: _SecondsRuler(total)),
              )),
          row('Shots', 28, (w) => Stack(children: [
                for (var i = 0; i < shots.length; i++)
                  Positioned(
                    left: w * shots[i].start / total,
                    width: (w * (shots[i].end - shots[i].start) / total - 2).clamp(4.0, w),
                    top: 3,
                    bottom: 3,
                    child: GestureDetector(
                      onTap: () => onPick(i + 1),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        decoration: BoxDecoration(
                          color: (verdicts[i + 1] == null ? _G.selected : (verdicts[i + 1]!['approved'] == true ? _C.ok : _C.bad)).withValues(alpha: 0.45),
                          borderRadius: BorderRadius.circular(3),
                          border: Border.all(color: pick == i + 1 ? _G.boundary : Colors.transparent, width: 2),
                        ),
                        alignment: Alignment.centerLeft,
                        child: Text('${i + 1} ${shots[i].layout.replaceAll('_', ' ')}${verdicts[i + 1]?['score'] != null ? ' · ${verdicts[i + 1]!['score']}' : ''}',
                            maxLines: 1, overflow: TextOverflow.clip, style: const TextStyle(fontSize: 10.5, color: Colors.white, fontWeight: FontWeight.w600)),
                      ),
                    ),
                  ),
              ])),
          for (final target in rows)
            row(_elementName(target), 20, icon: _elementIcon(target), on: element == target, (w) => Stack(children: [
                  if (shot != null) Positioned(left: w * shot.start / total, width: w * (shot.end - shot.start) / total, top: 9, height: 2, child: const ColoredBox(color: _G.edge)),
                  for (final tw in tweens.where((x) => x.target == target))
                    Positioned(
                      left: w * tw.start / total,
                      width: (w * tw.duration / total).clamp(3.0, w),
                      top: 4,
                      bottom: 4,
                      child: Tooltip(
                        message: '${tw.start.toStringAsFixed(2)} s · ${tw.duration.toStringAsFixed(2)} s · ${tw.ease}',
                        child: Container(decoration: BoxDecoration(color: element == target ? _G.boundary : const Color(0xFF7C9CC9), borderRadius: BorderRadius.circular(2))),
                      ),
                    ),
                ])),
          if (targets.length > rows.length) row('+${targets.length - rows.length} more', 16, (w) => const SizedBox()),
          row('Audio', 24, icon: Icons.graphic_eq_rounded, (w) => Stack(children: [
                for (final a in audio)
                  Positioned(
                    left: w * a.start / total,
                    width: (w * a.duration / total).clamp(3.0, w),
                    top: a.name == 'music' ? 4 : 13,
                    height: a.name == 'music' ? 8 : 7,
                    child: Tooltip(
                      message: '${a.name} at ${a.start.toStringAsFixed(2)} s',
                      child: Container(decoration: BoxDecoration(color: a.name == 'music' ? const Color(0xFF3B8A6A) : const Color(0xFFB98B3A), borderRadius: BorderRadius.circular(2))),
                    ),
                  ),
              ])),
        ]),
        // The playhead over every track.
        Positioned.fill(
          left: label,
          child: IgnorePointer(
            child: LayoutBuilder(
              builder: (context, c) => Stack(children: [
                Positioned(left: (c.maxWidth * playhead / total).clamp(0, c.maxWidth - 2), top: 0, bottom: 0, width: 2, child: const ColoredBox(color: Color(0xFFE5484D))),
              ]),
            ),
          ),
        ),
      ]),
    );
  }
}

class _SecondsRuler extends CustomPainter {
  _SecondsRuler(this.total);
  final double total;

  @override
  void paint(Canvas canvas, Size size) {
    final tick = Paint()
      ..color = _G.dim
      ..strokeWidth = 1;
    for (var s = 0.0; s <= total; s += 0.5) {
      final x = size.width * s / total;
      final major = s % 5 == 0;
      canvas.drawLine(Offset(x, size.height - (major ? 10 : (s % 1 == 0 ? 6 : 3))), Offset(x, size.height), tick);
      if (major) {
        final p = TextPainter(text: TextSpan(text: '${s.round()}s', style: const TextStyle(fontSize: 9, color: _G.dim)), textDirection: TextDirection.ltr)..layout();
        p.paint(canvas, Offset(x + 2, 1));
      }
    }
  }

  @override
  bool shouldRepaint(_SecondsRuler old) => false;
}

// The render, with its controls; the editor reads its time for the playhead and seeks it.
class _ReelVideo extends StatelessWidget {
  const _ReelVideo({required this.url, super.key});
  final String url;

  static final elements = <String, web.HTMLVideoElement>{};

  @override
  Widget build(BuildContext context) {
    final viewType = 'reel-video-$url';
    if (!elements.containsKey(url)) {
      final video = web.HTMLVideoElement()
        ..src = Api.fileUrl(url)
        ..autoplay = true
        ..loop = true
        ..muted = true
        ..controls = true
        ..playsInline = true
        ..style.width = '100%'
        ..style.height = '100%'
        ..style.objectFit = 'contain'
        ..style.background = '#000';
      elements[url] = video;
      ui_web.platformViewRegistry.registerViewFactory(viewType, (int _) => video);
    }
    return HtmlElementView(viewType: viewType);
  }
}


// A mouse pointer in the agent's color with its name, like a teammate's cursor.
class _Pointer extends StatelessWidget {
  const _Pointer({required this.agent, this.say});
  final _Agent agent;
  final String? say;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        CustomPaint(size: const Size(20, 22), painter: _Arrow(agent.color)),
        Transform.translate(
          offset: const Offset(12, -4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
              decoration: BoxDecoration(color: agent.color, borderRadius: BorderRadius.circular(5)),
              child: Text(agent.name, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Colors.white)),
            ),
            if (say != null && say!.trim().isNotEmpty)
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: Container(
                  key: ValueKey(say),
                  constraints: const BoxConstraints(maxWidth: 250),
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: const BorderRadius.only(topRight: Radius.circular(10), bottomLeft: Radius.circular(10), bottomRight: Radius.circular(10), topLeft: Radius.circular(2)),
                    border: Border.all(color: agent.color, width: 1.5),
                  ),
                  child: Text(say!, maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, height: 1.35, color: Color(0xFF1B1540))),
                ),
              ),
          ]),
        ),
      ]);
}

class _Arrow extends CustomPainter {
  _Arrow(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..moveTo(0, 0)
      ..lineTo(0, size.height * 0.85)
      ..lineTo(size.width * 0.28, size.height * 0.62)
      ..lineTo(size.width * 0.48, size.height)
      ..lineTo(size.width * 0.62, size.height * 0.93)
      ..lineTo(size.width * 0.43, size.height * 0.56)
      ..lineTo(size.width * 0.8, size.height * 0.56)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
    canvas.drawPath(path, Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4);
  }

  @override
  bool shouldRepaint(_Arrow old) => old.color != color;
}





// A message of the team's chat: who says it, to whom, and what, in plain words.
class _Msg {
  const _Msg(this.seq, this.from, this.to, this.text, {this.tone, this.image, this.model});
  // The Meta model (or the tool) the agent used for it.
  final String? model;
  final int seq;
  final String from;
  final String? to;
  final String text;
  final Color? tone;
  final String? image;
}

String _first(String text, [int max = 160]) {
  final line = text.split('\n').first.trim();
  return line.length > max ? '${line.substring(0, max - 1)}…' : line;
}

// The run's events told as the agents talking to each other: each hand-off is a message to
// the agent who takes the work next; statuses only feed the "typing…" line.
List<_Msg> _chat(_View v) {
  final out = <_Msg>[];
  final rejected = <int>{};
  for (final line in v.lines) {
    final e = line.event;
    final d = e.data;
    final n = e.slide;
    switch ((line.role, e.type)) {
      case ('owner', _):
        out.add(_Msg(e.seq, 'owner', 'director', e.text));
      case ('director', 'thought') when d is Map && d['reply'] == true:
        final edits = (d['edits'] as List?)?.length ?? 0;
        out.add(_Msg(e.seq, 'director', 'owner', '${e.text}${edits > 0 ? ' I’m sending $edits ${edits == 1 ? 'change' : 'changes'} to the designer.' : ''}', model: 'Muse Spark'));
      case ('analyst', 'assets'):
        out.add(_Msg(e.seq, 'analyst', 'director', 'I read the website. ${_first(e.text, 140)} Your turn.', model: 'Muse Spark · vision'));
      case ('director', 'thought') when d is Map:
        out.add(_Msg(e.seq, 'director', 'art', 'Here is the plan: ${(d['slides'] as List?)?.length ?? ''} slides, ${d['format'] ?? 'a carousel'}. “${d['concept'] ?? ''}”. Give it a look.', model: 'Muse Spark'));
      case ('art', 'thought'):
        out.add(_Msg(e.seq, 'art', 'designer', 'The look is set. ${_first(e.text.replaceFirst('Visual system for every slide: ', ''), 150)}', model: 'Muse Wonder'));
      case ('analyst', 'status') when e.text.startsWith('SAM 3.1') || e.text.contains(' cut out of photo') || e.text.contains('cut the'):
        out.add(_Msg(e.seq, 'analyst', 'designer', _first(e.text, 150), model: 'SAM 3.1'));
      case ('art', 'status') when e.text.startsWith('Decor kit') || e.text.startsWith('Backdrop'):
        out.add(_Msg(e.seq, 'art', 'designer', 'I painted it for you: ${_first(e.text.split(': ').skip(1).join(': '), 130)}', model: 'Muse Image', image: d is Map ? d['url'] as String? : null));
      case ('art', 'status') when e.text.startsWith('So it doesn'):
        out.add(_Msg(e.seq, 'art', 'designer', 'I changed it so it doesn’t look like the last brands: ${_first(e.text.split(': ').skip(1).join(': '), 120)}'));
      case ('designer', 'snapshot') when n != null:
        out.add(_Msg(e.seq, 'designer', 'critic', 'Slide $n is ready in GIMP (${e.text.toLowerCase()}). Can you check it?', image: d is Map ? '${d['url']}' : null, model: 'GIMP'));
      case ('critic', 'review') when n != null:
        final ok = d is Map ? d['approved'] == true : e.text.startsWith('All checks');
        final score = d is Map ? d['score'] : null;
        if (ok) {
          out.add(_Msg(e.seq, 'critic', 'designer', 'Slide $n is approved${score != null ? ' ($score/10)' : ''}. Next one!', tone: _C.ok, model: 'Muse Spark · vision'));
        } else {
          rejected.add(n);
          final arrow = e.text.indexOf('→');
          final why = (arrow > 0 ? e.text.substring(0, arrow) : e.text).replaceFirst(RegExp(r'^Rejected \(\d+/10\)\.\s*'), '');
          out.add(_Msg(e.seq, 'critic', 'fixer', 'Slide $n doesn’t pass yet${score != null ? ' ($score/10)' : ''}: ${_first(why, 150)}', tone: _C.bad, model: 'Muse Spark · vision'));
        }
      case ('fixer', 'thought') when e.agent == 'motion':
        out.add(_Msg(e.seq, 'fixer', 'designer', '${_first(e.text, 160)} Render it again, please.', model: 'Muse Spark'));
      case ('fixer', 'thought'):
        out.add(_Msg(e.seq, 'fixer', 'critic', '${_first(e.text, 150)} Check slide ${n ?? ''} again, please.', model: 'Muse Spark'));
      case ('critic', 'review') when d is Map && d['reel'] == true && d['shot'] is int:
        final ok = d['approved'] == true;
        out.add(_Msg(e.seq, 'critic', ok ? 'designer' : 'fixer', ok ? 'Shot ${d['shot']} of the reel works (${d['score']}/10).' : 'Shot ${d['shot']} of the reel needs work (${d['score']}/10): ${_first(e.text.split(').').skip(1).join(').'), 130)}', tone: ok ? _C.ok : _C.bad));
      case ('critic', 'review') when n == null:
        out.add(_Msg(e.seq, 'critic', null, 'Everyone: ${_first(e.text, 170)}', tone: _C.violet));
      case ('designer', 'thought') when e.agent == 'motion' && d is Map && d['reel'] is Map:
        out.add(_Msg(e.seq, 'designer', 'critic', 'The 30 s reel is laid out in HyperFrames: ${((d['reel'] as Map)['shots'] as List?)?.length ?? ''} shots. Rendering it for you.', model: 'HyperFrames'));
      case (_, 'done'):
        out.add(_Msg(e.seq, 'system', null, _first(e.text, 80), tone: _C.ok));
      case (_, 'error'):
        out.add(_Msg(e.seq, 'system', null, 'The run stopped: ${_first(e.text, 120)}', tone: _C.bad));
    }
  }
  return out;
}

// The agency's team chat: who is on the team, their hand-offs to each other as messages,
// and who is typing now.
class _TeamChat extends StatelessWidget {
  const _TeamChat({required this.view, required this.busy, required this.wide, required this.onWide, required this.canTalk, required this.onSend});
  final _View view;
  final bool busy;
  final bool wide;
  final VoidCallback onWide;
  final bool canTalk;
  final Future<String?> Function(String) onSend;

  @override
  Widget build(BuildContext context) {
    final messages = _chat(view);
    final active = busy ? _agent(view.active ?? '') : null;
    final typing = active == null ? null : view.said[active.key]?.event;
    return _Panel(
      title: 'Team chat',
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 7, height: 7, decoration: const BoxDecoration(color: _C.ok, shape: BoxShape.circle)),
        const SizedBox(width: 5),
        Text('${_team.length} online', style: mono(size: 11, color: _C.faint)),
        const SizedBox(width: 6),
        IconButton(
          tooltip: wide ? 'Make the chat smaller' : 'Expand the chat',
          visualDensity: VisualDensity.compact,
          onPressed: onWide,
          icon: Icon(wide ? Icons.close_fullscreen_rounded : Icons.open_in_full_rounded, size: 17, color: _C.muted),
        ),
      ]),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Who is on the team: the name, what they do on hover, lit while working.
        Container(
          padding: const EdgeInsets.fromLTRB(8, 10, 8, 10),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: _C.line))),
          // Top-aligned: avatars and names on one line whatever the number of tools under them.
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final a in _team)
              Expanded(
                child: Tooltip(
                  message: '${a.name}: ${a.job}\n${a.models.join(' · ')}',
                  child: Column(children: [
                    _Avatar(agent: a, working: active?.key == a.key, idle: (view.talks[a.key] ?? 0) == 0, size: 30),
                    const SizedBox(height: 4),
                    Text(a.name.split(' ').first, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10.5, fontWeight: active?.key == a.key ? FontWeight.w800 : FontWeight.w600, color: active?.key == a.key ? a.color : _C.muted)),
                    // What each agent works with: Meta's models, GIMP or HyperFrames.
                    for (final m in a.models)
                      Text(m, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: mono(size: 8.5, color: m.startsWith('Muse') || m.startsWith('SAM') ? const Color(0xFF0866FF) : _C.faint, weight: FontWeight.w700)),
                  ]),
                ),
              ),
          ]),
        ),
        Expanded(
          child: messages.isEmpty && typing == null
              ? const Center(child: Text('The team starts talking as soon as the analyst opens the website.', textAlign: TextAlign.center, style: TextStyle(color: _C.faint)))
              : ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
                  itemCount: messages.length,
                  itemBuilder: (context, i) {
                    final m = messages[messages.length - 1 - i];
                    return _Arrive(key: ValueKey(m.seq), child: _ChatLine(msg: m));
                  },
                ),
        ),
        // Only when the owner can really write: a carousel ready and the team free.
        if (canTalk) _DirectorBox(enabled: canTalk, busy: busy, onSend: onSend),
        if (active != null)
          Container(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
            decoration: const BoxDecoration(border: Border(top: BorderSide(color: _C.line))),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _Avatar(agent: active, working: true, idle: false, size: 22),
              const SizedBox(width: 8),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text('${active.name} is typing', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: active.color)),
                    const SizedBox(width: 6),
                    _Dots(color: active.color),
                  ]),
                  if (typing != null)
                    Text(_first(typing.text, 110), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, height: 1.35, color: _C.faint)),
                ]),
              ),
            ]),
          ),
      ]),
    );
  }
}

class _ChatLine extends StatelessWidget {
  const _ChatLine({required this.msg});
  final _Msg msg;

  @override
  Widget build(BuildContext context) {
    final from = _agent(msg.from);
    final to = msg.to == null ? null : _agent(msg.to!);
    if (msg.from == 'owner') {
      // The owner's own message, on the right as in any chat.
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Flexible(
            child: Container(
              margin: const EdgeInsets.only(left: 40),
              padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
              decoration: const BoxDecoration(
                color: _C.violet,
                borderRadius: BorderRadius.only(topLeft: Radius.circular(12), bottomLeft: Radius.circular(12), bottomRight: Radius.circular(12), topRight: Radius.circular(3)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('You → @Director', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Colors.white70)),
                const SizedBox(height: 2),
                Text(msg.text, style: const TextStyle(fontSize: 12.5, height: 1.4, color: Colors.white)),
              ]),
            ),
          ),
        ]),
      );
    }
    if (from == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(color: (msg.tone ?? _C.faint).withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
            child: Text(msg.text, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: msg.tone ?? _C.muted)),
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _Avatar(agent: from, working: false, idle: false, size: 28),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text(from.name, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: from.color)),
              if (msg.model != null) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(color: const Color(0xFF0866FF).withValues(alpha: msg.model == 'GIMP' || msg.model == 'HyperFrames' ? 0.0 : 0.08), borderRadius: BorderRadius.circular(4), border: Border.all(color: msg.model == 'GIMP' || msg.model == 'HyperFrames' ? _C.line : const Color(0xFF0866FF).withValues(alpha: 0.4))),
                  child: Text(msg.model!, style: mono(size: 9.5, color: msg.model == 'GIMP' || msg.model == 'HyperFrames' ? _C.muted : const Color(0xFF0866FF), weight: FontWeight.w700)),
                ),
              ],
            ]),
            const SizedBox(height: 3),
            Container(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
              decoration: BoxDecoration(
                color: (msg.tone ?? from.color).withValues(alpha: 0.07),
                border: Border.all(color: (msg.tone ?? from.color).withValues(alpha: 0.3)),
                borderRadius: const BorderRadius.only(topRight: Radius.circular(12), bottomLeft: Radius.circular(12), bottomRight: Radius.circular(12), topLeft: Radius.circular(3)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text.rich(
                  TextSpan(children: [
                    if (to != null) TextSpan(text: '@${to.name} ', style: TextStyle(fontWeight: FontWeight.w800, color: to.color)),
                    if (to == null && msg.to == 'owner') const TextSpan(text: '@You ', style: TextStyle(fontWeight: FontWeight.w800, color: _C.violet)),
                    TextSpan(text: msg.text),
                  ]),
                  style: const TextStyle(fontSize: 12.5, height: 1.4, color: _C.text),
                ),
                if (msg.image != null && msg.image!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: ClipRRect(borderRadius: BorderRadius.circular(6), child: SizedBox(width: 72, height: 90, child: _Net(msg.image!, fit: BoxFit.cover))),
                  ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  }
}

// A new message slides up and fades in.
class _Arrive extends StatefulWidget {
  const _Arrive({super.key, required this.child});
  final Widget child;

  @override
  State<_Arrive> createState() => _ArriveState();
}

class _ArriveState extends State<_Arrive> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 350))..forward();

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: c,
        child: SlideTransition(position: Tween(begin: const Offset(0, 0.25), end: Offset.zero).animate(CurvedAnimation(parent: c, curve: Curves.easeOut)), child: widget.child),
      );
}

// The three dots of someone typing.
class _Dots extends StatefulWidget {
  const _Dots({required this.color});
  final Color color;

  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: c,
        builder: (context, _) => Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < 3; i++)
            Container(
              width: 5,
              height: 5,
              margin: const EdgeInsets.only(right: 3),
              decoration: BoxDecoration(
                color: widget.color.withValues(alpha: 0.3 + 0.7 * (((c.value * 3 - i) % 3) < 1 ? 1 : 0)),
                shape: BoxShape.circle,
              ),
            ),
        ]),
      );
}


// The Reels safe zone (the template keeps text and logo inside x 80-1000, y 280-1470 of
// 1080x1920): Instagram's top bar, its caption and buttons below and its icons on the right
// cover the rest.
class _SafeAreas extends StatelessWidget {
  const _SafeAreas();

  static const x1 = 80 / 1080, x2 = 1000 / 1080, y1 = 280 / 1920, y2 = 1470 / 1920;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final w = c.maxWidth;
        final h = c.maxHeight;
        const shade = Color(0x66000000);
        Widget label(String text) => Text(text, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: Colors.white));
        return Stack(children: [
          Positioned(left: 0, right: 0, top: 0, height: h * y1, child: Container(color: shade, alignment: Alignment.center, child: label('Instagram top bar'))),
          Positioned(left: 0, right: 0, top: h * y2, bottom: 0, child: Container(color: shade, alignment: Alignment.center, child: label('Caption, music and buttons'))),
          Positioned(left: 0, width: w * x1, top: h * y1, height: h * (y2 - y1), child: const ColoredBox(color: shade)),
          Positioned(left: w * x2, right: 0, top: h * y1, height: h * (y2 - y1), child: const ColoredBox(color: shade)),
          Positioned(left: w * x1, top: h * y1, width: w * (x2 - x1), height: h * (y2 - y1), child: CustomPaint(painter: _Dashed())),
        ]);
      });
}


// Every image the analyst found on the website (not logos or icons): the run's photos, and
// the rest by their asset id, which the server turns into a photo when it's chosen.
List<_RunPhoto> _websiteChoices(List<_RunPhoto> photos, Map? site, {Set<String> excluded = const {}, bool cutouts = false}) {
  final assets = ((site?['assets'] as List?) ?? const []).whereType<Map>().where((a) => a['kind'] != 'logo' && a['kind'] != 'icon' && !excluded.contains(a['id']));
  final mine = photos.where((p) => (cutouts || !p.cutout) && !excluded.contains(p.asset)).toList();
  return [
    ...mine,
    for (final a in assets)
      if (!photos.any((p) => p.asset == a['id'])) (id: '${a['id']}', url: '${a['url']}', note: '${a['description'] ?? ''}', cutout: false, asset: '${a['id']}'),
  ];
}

// The top of every modal in the room: what it's about in violet, the title and a line.
class _DialogHeader extends StatelessWidget {
  const _DialogHeader({required this.kicker, required this.title, this.text, this.onClose});
  final String kicker;
  final String title;
  final String? text;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(24, 20, onClose == null ? 24 : 12, 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(kicker, style: mono(size: 11, color: _C.violet, weight: FontWeight.w800, spacing: 0.6)),
              const SizedBox(height: 4),
              Text(title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: _C.text, letterSpacing: -0.2)),
              if (text != null) ...[
                const SizedBox(height: 4),
                Text(text!, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w400, color: _C.muted, height: 1.4)),
              ],
            ]),
          ),
          if (onClose != null) IconButton(tooltip: 'Close', onPressed: onClose, icon: const Icon(Icons.close_rounded, color: _C.muted)),
        ]),
      );
}

String _hostOf(String? url) => (Uri.tryParse(url ?? '')?.host ?? '').replaceFirst(RegExp(r'^www\.'), '');

// The photo for a slide: everything from the website in one grid, the one in use marked.
Future<String?> _pickPhotoDialog(BuildContext context, {required int slide, required List<_RunPhoto> choices, required String? current, String host = ''}) {
  final size = MediaQuery.sizeOf(context);
  return showDialog<String>(
    context: context,
    barrierColor: const Color(0x991B1540),
    builder: (context) => Dialog(
      backgroundColor: _C.panel,
      surfaceTintColor: Colors.transparent,
      insetPadding: const EdgeInsets.all(24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: _C.line)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 860, maxHeight: size.height * 0.86),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _DialogHeader(
            kicker: 'SLIDE ${slide.toString().padLeft(2, '0')}',
            title: 'Choose its photo',
            text: '${choices.length} ${choices.length == 1 ? 'image' : 'images'} from ${host.isEmpty ? 'the website' : host}. The designer rebuilds the slide with the one you pick.',
            onClose: () => Navigator.pop(context),
          ),
          const Divider(height: 1, color: _C.line),
          Flexible(
            child: choices.isEmpty
                ? const Padding(
                    padding: EdgeInsets.all(40),
                    child: Text('The analyst found no photos on the website.', textAlign: TextAlign.center, style: TextStyle(color: _C.faint)),
                  )
                : GridView.builder(
                    shrinkWrap: true,
                    padding: const EdgeInsets.all(20),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 180, mainAxisSpacing: 14, crossAxisSpacing: 14, childAspectRatio: 0.8),
                    itemCount: choices.length,
                    itemBuilder: (context, i) => _PickTile(photo: choices[i], current: choices[i].id == current, onTap: () => Navigator.pop(context, choices[i].id)),
                  ),
          ),
        ]),
      ),
    ),
  );
}

class _PickTile extends StatefulWidget {
  const _PickTile({required this.photo, required this.current, required this.onTap});
  final _RunPhoto photo;
  final bool current;
  final VoidCallback onTap;

  @override
  State<_PickTile> createState() => _PickTileState();
}

class _PickTileState extends State<_PickTile> {
  bool hover = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.photo;
    final on = widget.current;
    return MouseRegion(
      cursor: on ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => hover = true),
      onExit: (_) => setState(() => hover = false),
      child: GestureDetector(
        onTap: on ? null : widget.onTap,
        child: Tooltip(
          message: p.note.isEmpty ? p.id : p.note,
          waitDuration: const Duration(milliseconds: 500),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            decoration: BoxDecoration(
              color: _C.raised,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: on ? _C.violet : (hover ? _C.violet.withValues(alpha: 0.45) : _C.line), width: on ? 2.5 : 1),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(fit: StackFit.expand, children: [
              Padding(padding: EdgeInsets.all(p.cutout ? 12 : 0), child: _Net(p.url, fit: p.cutout ? BoxFit.contain : BoxFit.cover)),
              if (on)
                Positioned(
                  top: 8,
                  right: 8,
                  child: Container(
                    padding: const EdgeInsets.all(3),
                    decoration: const BoxDecoration(color: _C.violet, shape: BoxShape.circle),
                    child: const Icon(Icons.check_rounded, size: 14, color: Colors.white),
                  ),
                ),
              Positioned(
                left: 8,
                bottom: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(color: on ? _C.violet : Colors.white.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(999), border: on ? null : Border.all(color: _C.line)),
                  child: Text(on ? 'On the slide' : (p.cutout ? 'Cut out' : (hover ? 'Use this one' : 'Photo')),
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: on ? Colors.white : _C.text)),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({required this.photo, required this.current, required this.onTap});
  final _RunPhoto photo;
  final bool current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: '${photo.id}${photo.cutout ? ' · cut out' : ''}${photo.note.isNotEmpty ? ' · ${photo.note}' : ''}',
        child: InkWell(
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(
              color: const Color(0xFFF4F3F8),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: current ? _G.boundary : _G.edge, width: current ? 2.5 : 1),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(fit: StackFit.expand, children: [
              _Net(photo.url, fit: photo.cutout ? BoxFit.contain : BoxFit.cover),
              Positioned(
                left: 3,
                bottom: 3,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                  decoration: BoxDecoration(color: current ? _G.boundary : Colors.black54, borderRadius: BorderRadius.circular(3)),
                  child: Text(current ? 'in use' : photo.id, style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w700, color: current ? Colors.black : Colors.white)),
                ),
              ),
            ]),
          ),
        ),
      );
}


// The owner writes to the director, the one who planned the carousel.
class _DirectorBox extends StatefulWidget {
  const _DirectorBox({required this.enabled, required this.busy, required this.onSend});
  final bool enabled;
  final bool busy;
  final Future<String?> Function(String) onSend;

  @override
  State<_DirectorBox> createState() => _DirectorBoxState();
}

class _DirectorBoxState extends State<_DirectorBox> {
  final text = TextEditingController();
  bool sending = false;
  String? error;

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  Future<void> send() async {
    final value = text.text.trim();
    if (value.isEmpty || !widget.enabled || sending) return;
    setState(() {
      sending = true;
      error = null;
    });
    final failed = await widget.onSend(value);
    if (!mounted) return;
    setState(() {
      sending = false;
      error = failed;
      if (failed == null) text.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final director = _agent('director')!;
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: _C.line))),
      child: Row(children: [
        _Avatar(agent: director, working: false, idle: !widget.enabled, size: 26),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: text,
            enabled: widget.enabled && !sending,
            onSubmitted: (_) => send(),
            minLines: 1,
            maxLines: 3,
            style: const TextStyle(fontSize: 13),
            decoration: InputDecoration(
              isDense: true,
              border: InputBorder.none,
              hintText: widget.enabled ? 'Message the director…' : (widget.busy ? 'The team is working; you can write when it\'s done.' : 'You can write to the director once the carousel is ready.'),
              hintStyle: const TextStyle(color: _C.faint, fontSize: 12.5),
              errorText: error,
              errorMaxLines: 2,
            ),
          ),
        ),
        IconButton(
          tooltip: 'Send to the director',
          onPressed: widget.enabled && !sending ? send : null,
          icon: sending ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(Icons.send_rounded, color: widget.enabled ? _C.violet : _C.faint),
        ),
      ]),
    );
  }
}

// The carousel as it shows in the feed: the account, the slides to swipe, the caption.
class _FeedPreview extends StatefulWidget {
  const _FeedPreview({required this.view, required this.host});
  final _View view;
  final String host;

  @override
  State<_FeedPreview> createState() => _FeedPreviewState();
}

class _FeedPreviewState extends State<_FeedPreview> {
  final pages = PageController();
  int page = 0;

  @override
  void dispose() {
    pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.view;
    final slides = [for (final n in v.order) v.slides[n]!].where((s) => s.url != null && s.url!.isNotEmpty).toList();
    final host = (Uri.tryParse(widget.host)?.host ?? '').replaceFirst(RegExp(r'^www\.'), '');
    final handle = host.split('.').first;
    final logo = v.site?['logo'] as String?;
    return Container(
      decoration: BoxDecoration(color: _C.raised, borderRadius: BorderRadius.circular(12), border: Border.all(color: _C.line)),
      alignment: Alignment.topCenter,
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 20),
        child: Container(
          width: 420,
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14), border: Border.all(color: _C.line)),
          clipBehavior: Clip.antiAlias,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              child: Row(children: [
                Container(
                  width: 34,
                  height: 34,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white, border: Border.all(color: _C.line)),
                  child: ClipOval(child: logo != null ? _Net(logo, fit: BoxFit.contain) : const Icon(Icons.storefront_outlined, size: 16, color: _C.faint)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(handle.isEmpty ? 'your_business' : handle, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5)),
                    const Text('Sponsored', style: TextStyle(fontSize: 11, color: _C.faint)),
                  ]),
                ),
                const Icon(Icons.more_horiz_rounded, color: _C.muted),
              ]),
            ),
            AspectRatio(
              aspectRatio: 4 / 5,
              child: slides.isEmpty
                  ? const ColoredBox(color: _C.raised, child: Center(child: Text('The slides show here as the designer saves them.', style: TextStyle(color: _C.faint))))
                  : Stack(children: [
                      PageView(
                        controller: pages,
                        onPageChanged: (i) => setState(() => page = i),
                        children: [for (final s in slides) _Net(s.url!, fit: BoxFit.cover)],
                      ),
                      Positioned(
                        right: 10,
                        top: 10,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                          child: Text('${page + 1}/${slides.length}', style: const TextStyle(fontSize: 11.5, color: Colors.white, fontWeight: FontWeight.w700)),
                        ),
                      ),
                      for (final (dx, icon, to) in [(-1.0, Icons.chevron_left_rounded, page - 1), (1.0, Icons.chevron_right_rounded, page + 1)])
                        if (to >= 0 && to < slides.length)
                          Align(
                            alignment: Alignment(dx * 0.95, 0),
                            child: InkWell(
                              onTap: () => pages.animateToPage(to, duration: const Duration(milliseconds: 300), curve: Curves.easeOut),
                              child: Container(
                                width: 30,
                                height: 30,
                                decoration: const BoxDecoration(color: Colors.white70, shape: BoxShape.circle),
                                child: Icon(icon, color: Colors.black87),
                              ),
                            ),
                          ),
                    ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
              child: Row(children: [
                const Icon(Icons.favorite_border_rounded, size: 24),
                const SizedBox(width: 14),
                const Icon(Icons.mode_comment_outlined, size: 22),
                const SizedBox(width: 14),
                const Icon(Icons.send_outlined, size: 22),
                const Spacer(),
                for (var i = 0; i < slides.length; i++)
                  Container(
                    width: 6,
                    height: 6,
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    decoration: BoxDecoration(shape: BoxShape.circle, color: i == page ? const Color(0xFF0866FF) : _C.line),
                  ),
                const Spacer(),
                const Icon(Icons.bookmark_border_rounded, size: 24),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 14),
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: '${handle.isEmpty ? 'your_business' : handle} ', style: const TextStyle(fontWeight: FontWeight.w800)),
                  TextSpan(text: v.caption ?? 'The caption shows here when the carousel is ready.'),
                  if (v.hashtags.isNotEmpty) TextSpan(text: '\n${v.hashtags.join(' ')}', style: const TextStyle(color: Color(0xFF00376B))),
                ]),
                style: const TextStyle(fontSize: 13, height: 1.4, color: _C.text),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}


// GIMP's guides: blue dashed lines on the margins and the center of the slide.
class _Guides extends CustomPainter {
  _Guides(this.w, this.h);
  final double w;
  final double h;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xCC3D8BFF)
      ..strokeWidth = 1;
    void dashed(Offset a, Offset b) {
      final d = b - a;
      final len = d.distance;
      for (var t = 0.0; t < len; t += 9) {
        canvas.drawLine(a + d * (t / len), a + d * ((t + 5).clamp(0, len) / len), paint);
      }
    }

    final sx = size.width / w;
    final sy = size.height / h;
    for (final x in [80.0, w / 2, w - 80]) {
      dashed(Offset(x * sx, 0), Offset(x * sx, size.height));
    }
    for (final y in [80.0, h - 80]) {
      dashed(Offset(0, y * sy), Offset(size.width, y * sy));
    }
  }

  @override
  bool shouldRepaint(_Guides old) => false;
}

// The director's plan as a storyboard: every slide with its photo and words. From Create the
// plan waits a moment for the owner: words, photos and slides can change before the design.
class _PlanBoard extends StatefulWidget {
  const _PlanBoard({required this.runId, required this.view, required this.live, required this.excluded, required this.onToggle});
  final String runId;
  final _View view;
  final bool live;
  final Set<String> excluded;
  final void Function(String) onToggle;

  @override
  State<_PlanBoard> createState() => _PlanBoardState();
}

class _PlanBoardState extends State<_PlanBoard> {
  List<_RunPhoto> photos = const [];
  Map<int, String> used = const {};
  final edits = <int, Map<String, String>>{};
  final removed = <int>{};
  final photoFor = <int, String>{};
  final note = TextEditingController();
  Timer? tick;
  bool sent = false;
  String? error;

  @override
  void initState() {
    super.initState();
    load();
    tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && reviewing) setState(() {});
    });
  }

  @override
  void didUpdateWidget(_PlanBoard old) {
    super.didUpdateWidget(old);
    if (photos.isEmpty) load();
  }

  @override
  void dispose() {
    tick?.cancel();
    note.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final (list, map) = await _runPhotos(widget.runId);
      if (!mounted) return;
      setState(() {
        photos = list;
        used = map;
      });
    } catch (_) {}
  }

  bool get reviewing => !sent && widget.live && widget.view.planUntil != null && widget.view.planUntil!.isAfter(DateTime.now());

  List<Map> get planSlides => ((widget.view.plan?['slides'] as List?) ?? const []).whereType<Map>().toList();

  String photoOf(Map slide) => photoFor[slide['n']] ?? '${slide['photo'] ?? used[slide['n']] ?? ''}';

  Future<void> approve() async {
    final slides = [
      for (final sl in planSlides)
        {
          'n': sl['n'],
          ...?edits[sl['n']],
          if (photoFor[sl['n']] != null) 'photo': photoFor[sl['n']],
          if (removed.contains(sl['n'])) 'remove': true,
        },
    ];
    try {
      await Api.reviewPlan(widget.runId, slides, note.text.trim(), exclude: widget.excluded.toList());
      setState(() => sent = true);
    } catch (e) {
      setState(() => error = '$e'.replaceFirst('Exception: ', ''));
    }
  }

  // Every image the analyst found on the website (not logos or icons): the run's photos, and
  // the rest by their asset id, which the server turns into a photo when it's chosen.
  List<_RunPhoto> get choices => _websiteChoices(photos, widget.view.site, excluded: widget.excluded);

  Future<void> pick(int n) async {
    final id = await _pickPhotoDialog(context, slide: n, choices: choices, current: photoOf(planSlides.firstWhere((x) => x['n'] == n)), host: _hostOf(widget.view.url));
    if (id != null) setState(() => photoFor[n] = id);
  }

  @override
  Widget build(BuildContext context) {
    final plan = widget.view.plan ?? const {};
    final slides = planSlides;
    final left = widget.view.planUntil == null ? 0 : widget.view.planUntil!.difference(DateTime.now()).inSeconds.clamp(0, 999);
    final photoUrl = {for (final p in [...photos, ...choices]) p.id: p};
    final inUse = {for (final sl in slides) if (!removed.contains(sl['n'])) photoOf(sl)};
    return _Panel(
      title: 'The director\'s plan',
      trailing: Text('${plan['format'] ?? ''}'.toUpperCase(), style: mono(size: 11, color: _colorOf('director'), weight: FontWeight.w700)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: ListView(padding: const EdgeInsets.all(18), children: [
            Text('${plan['concept'] ?? ''}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1.25, letterSpacing: -0.3)),
            const SizedBox(height: 6),
            Text('${plan['why'] ?? ''}', maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: _C.muted, height: 1.45)),
            const SizedBox(height: 16),
            // Every photo from the website, and the ones the plan uses.
            Row(children: [
              const Text('Photos from the website', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
              const SizedBox(width: 8),
              Text('${inUse.where((id) => id.isNotEmpty).length} used · ${photos.length} found', style: mono(size: 11, color: _C.faint)),
            ]),
            const SizedBox(height: 8),
            SizedBox(
              height: 74,
              child: ListView(scrollDirection: Axis.horizontal, children: [
                for (final p in photos)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Opacity(
                      opacity: inUse.contains(p.id) ? 1 : 0.45,
                      child: SizedBox(
                        width: 60,
                        child: Stack(fit: StackFit.expand, children: [
                          _PhotoTile(
                            photo: p,
                            current: inUse.contains(p.id),
                            onTap: () {
                              final asset = (widget.view.site?['assets'] as List?)?.whereType<Map>().where((a) => a['id'] == p.asset).firstOrNull;
                              showAsset(context, asset ?? {'url': p.url, 'kind': p.cutout ? 'cut out' : 'photo', 'description': p.note, 'id': p.asset}, widget.excluded.contains(p.asset),
                                  reviewing && p.asset.isNotEmpty ? () => widget.onToggle(p.asset) : null);
                            },
                          ),
                          if (widget.excluded.contains(p.asset)) const Positioned(right: 2, top: 2, child: Icon(Icons.block_rounded, size: 16, color: _C.bad)),
                        ]),
                      ),
                    ),
                  ),
              ]),
            ),
            const SizedBox(height: 18),
            Text('${slides.length - removed.length} slides', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
            const SizedBox(height: 8),
            Wrap(spacing: 12, runSpacing: 12, children: [
              for (final sl in slides)
                _PlanCard(
                  slide: sl,
                  photo: photoUrl[photoOf(sl)],
                  leftOut: widget.excluded.contains(photoUrl[photoOf(sl)]?.asset),
                  editable: reviewing,
                  removed: removed.contains(sl['n']),
                  canRemove: slides.length - removed.length > 3,
                  onPick: () => pick(sl['n'] as int),
                  onEdit: (field, value) => (edits[sl['n'] as int] ??= {})[field] = value,
                  onRemove: () => setState(() => removed.contains(sl['n']) ? removed.remove(sl['n']) : removed.add(sl['n'] as int)),
                ),
            ]),
          ]),
        ),
        if (reviewing)
          Container(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            decoration: BoxDecoration(color: _C.violet.withValues(alpha: 0.06), border: const Border(top: BorderSide(color: _C.line))),
            child: Row(children: [
              _Pill(text: 'Design starts in ${left ~/ 60}:${(left % 60).toString().padLeft(2, '0')}', color: _C.violet, blink: true),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: note,
                  style: const TextStyle(fontSize: 13),
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: 'Change the words, the photos or the slides above. Anything else for the director?',
                    hintStyle: const TextStyle(fontSize: 12.5, color: _C.faint),
                    border: const OutlineInputBorder(),
                    errorText: error,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(onPressed: approve, icon: const Icon(Icons.check_rounded), label: const Text('Approve the plan')),
            ]),
          ),
      ]),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({
    required this.slide,
    required this.photo,
    required this.editable,
    required this.removed,
    required this.canRemove,
    required this.onPick,
    required this.onEdit,
    required this.onRemove,
    this.leftOut = false,
  });
  final Map slide;
  final _RunPhoto? photo;
  // Its photo is one the owner left out: it changes when the plan is approved.
  final bool leftOut;
  final bool editable;
  final bool removed;
  final bool canRemove;
  final VoidCallback onPick;
  final void Function(String, String) onEdit;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final n = slide['n'] as int;
    Widget field(String key, String label, double size, FontWeight weight) {
      final value = '${slide[key] ?? ''}';
      if (value.isEmpty && !editable) return const SizedBox();
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: editable
            ? TextFormField(
                initialValue: value,
                maxLines: null,
                onChanged: (v) => onEdit(key, v),
                style: TextStyle(fontSize: size, fontWeight: weight, height: 1.3),
                decoration: InputDecoration(isDense: true, labelText: label, labelStyle: const TextStyle(fontSize: 11), border: const OutlineInputBorder()),
              )
            : Text(value, style: TextStyle(fontSize: size, fontWeight: weight, height: 1.3, color: key == 'headline' ? _C.text : _C.muted)),
      );
    }

    return Opacity(
      opacity: removed ? 0.4 : 1,
      child: Container(
        width: 230,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: _C.panel, borderRadius: BorderRadius.circular(10), border: Border.all(color: editable ? _C.violet.withValues(alpha: 0.5) : _C.line)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text('${n.toString().padLeft(2, '0')}  ${'${slide['role'] ?? ''}'.toUpperCase()}', style: mono(size: 10.5, color: _colorOf('director'), weight: FontWeight.w800)),
            const Spacer(),
            if (editable && (canRemove || removed))
              InkWell(
                onTap: onRemove,
                child: Text(removed ? 'Bring back' : 'Remove', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _C.bad)),
              ),
          ]),
          const SizedBox(height: 8),
          GestureDetector(
            onTap: editable ? onPick : null,
            child: AspectRatio(
              aspectRatio: 4 / 5,
              child: Container(
                decoration: BoxDecoration(color: _C.raised, borderRadius: BorderRadius.circular(6), border: Border.all(color: _C.line)),
                clipBehavior: Clip.antiAlias,
                child: Stack(fit: StackFit.expand, children: [
                  if (photo != null)
                    _Net(photo!.url, fit: photo!.cutout ? BoxFit.contain : BoxFit.cover)
                  else
                    const Center(child: Text('No photo: words only', style: TextStyle(fontSize: 11.5, color: _C.faint))),
                  if (leftOut)
                    Container(
                      color: Colors.white.withValues(alpha: 0.75),
                      alignment: Alignment.center,
                      padding: const EdgeInsets.all(12),
                      child: const Text('Left out: gets another photo when you approve', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: _C.bad)),
                    ),
                  if (editable)
                    Positioned(
                      left: 6,
                      bottom: 6,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                        decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.65), borderRadius: BorderRadius.circular(5)),
                        child: const Row(mainAxisSize: MainAxisSize.min, children: [
                          Icon(Icons.swap_horiz_rounded, size: 13, color: Colors.white),
                          SizedBox(width: 4),
                          Text('Change photo', style: TextStyle(fontSize: 11, color: Colors.white, fontWeight: FontWeight.w700)),
                        ]),
                      ),
                    ),
                ]),
              ),
            ),
          ),
          field('headline', 'Headline', 14, FontWeight.w800),
          field('body', 'Text', 12.5, FontWeight.w500),
          field('button', 'Button', 12, FontWeight.w700),
        ]),
      ),
    );
  }
}


// A website image, big, with what the AI read in it, and whether it goes on the slides.
void showAsset(BuildContext context, Map asset, bool leftOut, VoidCallback? onToggle) {
  showDialog<void>(
    context: context,
    builder: (context) => StatefulBuilder(builder: (context, setDialog) {
      var out = leftOut;
      return AlertDialog(
        titlePadding: EdgeInsets.zero,
        title: _DialogHeader(kicker: 'FROM THE WEBSITE', title: 'An image the analyst found', onClose: () => Navigator.pop(context)),
        contentPadding: const EdgeInsets.fromLTRB(24, 4, 24, 24),
        content: SizedBox(
          width: 760,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              flex: 3,
              child: Container(
                decoration: BoxDecoration(color: _C.raised, borderRadius: BorderRadius.circular(12), border: Border.all(color: _C.line)),
                clipBehavior: Clip.antiAlias,
                child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 520), child: _Net('${asset['url']}', fit: BoxFit.contain)),
              ),
            ),
            const SizedBox(width: 18),
            Expanded(
              flex: 2,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Row(children: [
                  _Avatar(agent: _agent('analyst')!, working: false, idle: false, size: 24),
                  const SizedBox(width: 8),
                  const Text('What the analyst read', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
                ]),
                const SizedBox(height: 4),
                Text('Muse Spark · vision', style: mono(size: 10, color: const Color(0xFF0866FF), weight: FontWeight.w700)),
                const SizedBox(height: 12),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  _Pill(text: '${asset['kind'] ?? 'image'}', color: _C.violet),
                  if (asset['hasText'] == true) const _Pill(text: 'text baked in', color: _C.warn),
                  if (asset['quality'] is num) _Pill(text: 'quality ${asset['quality']}', color: _C.muted),
                ]),
                const SizedBox(height: 10),
                Text('${asset['description'] ?? ''}'.isEmpty ? 'No description.' : '${asset['description']}', style: const TextStyle(fontSize: 13.5, height: 1.45)),
                const SizedBox(height: 18),
                if (onToggle != null)
                  SizedBox(
                    width: double.infinity,
                    child: out
                        ? FilledButton.icon(
                            onPressed: () {
                              onToggle();
                              setDialog(() => out = false);
                              Navigator.pop(context);
                            },
                            icon: const Icon(Icons.check_rounded),
                            label: const Text('Use it on the slides'),
                          )
                        : OutlinedButton.icon(
                            onPressed: () {
                              onToggle();
                              setDialog(() => out = true);
                              Navigator.pop(context);
                            },
                            icon: const Icon(Icons.block_rounded, color: _C.bad),
                            label: const Text('Leave it out'),
                          ),
                  ),
                if (onToggle != null)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text('What you leave out goes when you approve the plan.', style: TextStyle(fontSize: 11.5, color: _C.faint)),
                  ),
              ]),
            ),
          ]),
        ),
      );
    }),
  );
}


// A countdown pill that ticks on its own.
class _Countdown extends StatefulWidget {
  const _Countdown({required this.until, required this.label});
  final DateTime until;
  final String label;

  @override
  State<_Countdown> createState() => _CountdownState();
}

class _CountdownState extends State<_Countdown> {
  late final Timer tick = Timer.periodic(const Duration(seconds: 1), (_) {
    if (mounted) setState(() {});
  });

  @override
  void dispose() {
    tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.until.difference(DateTime.now()).inSeconds.clamp(0, 999);
    return _Pill(text: '${widget.label} ${left ~/ 60}:${(left % 60).toString().padLeft(2, '0')}', color: _C.violet, blink: true);
  }
}
