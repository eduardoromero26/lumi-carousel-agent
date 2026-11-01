import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'dart:ui_web' as ui_web;
import 'package:web/web.dart' as web;

import 'api.dart';
import 'feed.dart';
import 'learned.dart';
import 'queue.dart';

void main() => runApp(const CarouselAgentApp());

// White, thin borders, one violet, no shadows.
class Palette {
  static const primary = Color(0xFF6D4AFF);
  static const primarySoft = Color(0xFFEEEAFE);
  static const ink = Color(0xFF1B1540);
  static const muted = Color(0xFF5A5478);
  static const faint = Color(0xFF8A84A8);
  static const border = Color(0xFFE7E5EF);
  static const canvas = Color(0xFFFAFAFC);
  static const danger = Color(0xFFB42318);
  static const dangerSoft = Color(0xFFFEF3F2);
}

class CarouselAgentApp extends StatelessWidget {
  const CarouselAgentApp({super.key});

  @override
  Widget build(BuildContext context) {
    final rounded = RoundedRectangleBorder(borderRadius: BorderRadius.circular(10));
    OutlineInputBorder field(Color color, [double width = 1]) =>
        OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: color, width: width));
    const label = TextStyle(fontWeight: FontWeight.w700, fontSize: 15);
    return MaterialApp(
      title: 'Carousel Agent',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Palette.primary, primary: Palette.primary, surface: Colors.white, onSurface: Palette.ink, error: Palette.danger),
        textTheme: GoogleFonts.plusJakartaSansTextTheme().apply(bodyColor: Palette.ink, displayColor: Palette.ink),
        scaffoldBackgroundColor: Colors.white,
        dividerTheme: const DividerThemeData(color: Palette.border, thickness: 1, space: 1),
        cardTheme: CardThemeData(
          elevation: 0,
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: Palette.border)),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
          hintStyle: const TextStyle(color: Palette.faint),
          border: field(Palette.border),
          enabledBorder: field(Palette.border),
          focusedBorder: field(Palette.primary, 1.5),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(minimumSize: const Size(0, 48), shape: rounded, textStyle: label),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(0, 44),
            shape: rounded,
            foregroundColor: Palette.ink,
            side: const BorderSide(color: Palette.border),
            textStyle: label,
          ),
        ),
        chipTheme: ChipThemeData(
          backgroundColor: Colors.white,
          side: const BorderSide(color: Palette.border),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      home: const HomeShell(),
    );
  }
}

// Create (the studio where the agents work), Feed (every carousel as it would look on
// Instagram), Queue (many websites in a row) and Learned (what the agents learned).
// ?view=feed|queue|learned opens that tab; ?run=<id> opens that run in Create.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int tab = const {'feed': 1, 'queue': 2, 'learned': 3}[Uri.base.queryParameters['view']] ?? 0;

  @override
  Widget build(BuildContext context) {
    Widget tabButton(int i, IconData icon, String label) => TextButton.icon(
          onPressed: () => setState(() => tab = i),
          icon: Icon(icon, size: 18),
          label: Text(label),
          style: TextButton.styleFrom(
            foregroundColor: tab == i ? Palette.primary : Palette.muted,
            backgroundColor: tab == i ? Palette.primarySoft : null,
            textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
            shape: const StadiumBorder(),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          ),
        );
    return Scaffold(
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(color: Palette.primary, borderRadius: BorderRadius.circular(8)),
                child: const Icon(Icons.auto_awesome, color: Colors.white, size: 17),
              ),
              const SizedBox(width: 10),
              const Text('Carousel Agent', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, letterSpacing: -0.2)),
              const SizedBox(width: 24),
              tabButton(0, Icons.auto_awesome_outlined, 'Create'),
              const SizedBox(width: 4),
              tabButton(1, Icons.dynamic_feed_outlined, 'Feed'),
              const SizedBox(width: 4),
              tabButton(2, Icons.playlist_play, 'Queue'),
              const SizedBox(width: 4),
              tabButton(3, Icons.local_library_outlined, 'Learned'),
            ]),
          ),
          const Divider(height: 1),
          Expanded(
            child: IndexedStack(index: tab, children: [
              const StudioPage(),
              FeedPage(active: tab == 1),
              QueuePage(active: tab == 2),
              LearnedPage(active: tab == 3),
            ]),
          ),
        ]),
      ),
    );
  }
}

// The rendered HyperFrames card, playing in a loop like it will on Instagram.
class _LoopVideo extends StatelessWidget {
  const _LoopVideo({required this.url, super.key});
  final String url;

  @override
  Widget build(BuildContext context) {
    final viewType = 'loop-video-$url';
    if (_registered.add(viewType)) {
      ui_web.platformViewRegistry.registerViewFactory(viewType, (int _) {
        return web.HTMLVideoElement()
          ..src = url
          ..autoplay = true
          ..loop = true
          ..muted = true
          ..playsInline = true
          ..style.width = '100%'
          ..style.height = '100%'
          ..style.objectFit = 'cover';
      });
    }
    return HtmlElementView(viewType: viewType);
  }

  static final _registered = <String>{};
}

const agentColors = {
  'analyst': Color(0xFF2563EB),
  'director': Color(0xFF5B4BDB),
  'designer': Color(0xFF0E8A6A),
  'critic': Color(0xFFC2410C),
  'motion': Color(0xFFDB2777),
  'system': Color(0xFF6B7280),
};

class StudioPage extends StatefulWidget {
  const StudioPage({super.key});

  @override
  State<StudioPage> createState() => _StudioPageState();
}

// Language of the text on the slides, the caption and the hashtags.
const languages = ['Español', 'English', 'Português', 'Français', 'Italiano', 'Deutsch'];

class _StudioPageState extends State<StudioPage> {
  final website = TextEditingController();
  final business = TextEditingController();
  final goal = TextEditingController();
  final audience = TextEditingController();
  final colors = TextEditingController();
  final events = <RunEvent>[];
  final timeline = ScrollController();
  String language = web.window.navigator.language.startsWith('es') ? 'Español' : 'English';
  String? runId;
  String? error;
  StreamSubscription<RunEvent>? sub;
  // Off on the server (REELS) until a reel takes less than a run.
  bool reels = false;

  bool get running => runId != null && !const {'done', 'error'}.contains(events.lastOrNull?.type);
  RunEvent? get done => events.lastOrNull?.type == 'done' ? events.last : null;

  Map<String, dynamic>? get plan {
    final e = events.lastWhere((e) => e.agent == 'director' && e.type == 'thought' && e.data != null, orElse: () => _none);
    return e == _none ? null : e.data as Map<String, dynamic>;
  }

  // What the analyst found on the website, grouped for the UI.
  Map<String, dynamic>? get siteAssets => events.where((e) => e.type == 'assets').lastOrNull?.data as Map<String, dynamic>?;

  static final _none = RunEvent.fromJson(const {'seq': -1, 'type': '', 'agent': '', 'text': ''});

  @override
  void initState() {
    super.initState();
    // ?run=<id> reopens a run: the server replays its events.
    final id = Uri.base.queryParameters['run'];
    if (id != null && id.isNotEmpty) WidgetsBinding.instance.addPostFrameCallback((_) => listen(id));
    Api.config().then((c) {
      if (mounted) setState(() => reels = c['reels'] == true);
    }, onError: (_) {});
  }

  void refresh() => setState(() {});

  void setLanguage(String value) => setState(() => language = value);

  @override
  void dispose() {
    sub?.cancel();
    super.dispose();
  }

  Future<void> start() async {
    setState(() => error = null);
    try {
      final id = await Api.createRun(
        url: website.text.trim(),
        business: business.text.trim(),
        language: language,
        goal: goal.text.trim(),
        audience: audience.text.trim(),
        brandColors: colors.text.split(',').map((c) => c.trim()).where((c) => c.isNotEmpty).toList(),
      );
      listen(id);
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  void listen(String id) {
    sub?.cancel();
    setState(() {
      runId = id;
      events.clear();
    });
    sub = Api.events(id).listen((e) {
      if (events.any((x) => x.seq == e.seq)) return;
      setState(() => events.add(e));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (timeline.hasClients) timeline.jumpTo(timeline.position.maxScrollExtent);
      });
    });
  }

  Future<void> stop() async {
    try {
      await Api.stop(runId!);
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  Future<void> makeReel() async {
    try {
      await Api.reel(runId!);
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  Future<void> editSlide(int n, String feedback) async {
    try {
      await Api.editSlide(runId!, n, feedback);
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width > 980;
    // Before a run, the brief is the whole page; once the agents work, it moves to the side.
    if (runId == null) {
      return Scaffold(
        backgroundColor: Palette.canvas,
        body: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 48),
          child: Center(
            child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: _BriefForm(state: this, hero: true)),
          ),
        ),
      );
    }
    final form = _BriefForm(state: this);
    final work = _Workspace(state: this);
    return Scaffold(
      body: SafeArea(
        child: wide
            ? Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                SizedBox(width: 380, child: SingleChildScrollView(padding: const EdgeInsets.all(24), child: form)),
                const VerticalDivider(width: 1),
                Expanded(child: work),
              ])
            : ListView(padding: const EdgeInsets.all(16), children: [form, const SizedBox(height: 24), SizedBox(height: 900, child: work)]),
      ),
    );
  }
}

class _BriefForm extends StatelessWidget {
  const _BriefForm({required this.state, this.hero = false});
  final _StudioPageState state;
  final bool hero;

  @override
  Widget build(BuildContext context) {
    final s = state;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (hero) ...[
        Center(
          child: Container(
            width: 72,
            height: 72,
            decoration: const BoxDecoration(color: Palette.primarySoft, shape: BoxShape.circle),
            child: const Icon(Icons.auto_awesome, color: Palette.primary, size: 34),
          ),
        ),
        const SizedBox(height: 22),
      ],
      Text(
        "Let's start with your business",
        textAlign: hero ? TextAlign.center : TextAlign.start,
        style: TextStyle(fontSize: hero ? 32 : 22, fontWeight: FontWeight.w800, height: 1.12, letterSpacing: hero ? -0.64 : -0.3),
      ),
      SizedBox(height: hero ? 16 : 8),
      Text(
        'A director, a designer working in GIMP and a critic read your website and make your carousel. You just review.',
        textAlign: hero ? TextAlign.center : TextAlign.start,
        style: const TextStyle(color: Palette.muted, fontSize: 15, height: 1.5),
      ),
      SizedBox(height: hero ? 32 : 24),
      _Panel(
        hero: hero,
        children: [
          const _FieldLabel('Your website'),
          TextField(
            controller: s.website,
            keyboardType: TextInputType.url,
            onSubmitted: (_) => s.running ? null : s.start(),
            decoration: const InputDecoration(
              hintText: 'mytaqueria.com',
              prefixIcon: Icon(Icons.language_rounded, color: Palette.faint, size: 20),
            ),
          ),
          const SizedBox(height: 6),
          const Text('We read your texts, logo, colors and photos from it.', style: TextStyle(color: Palette.faint, fontSize: 13)),
          const SizedBox(height: 18),
          const _FieldLabel('Language of the slides'),
          DropdownButtonFormField<String>(
            initialValue: s.language,
            borderRadius: BorderRadius.circular(10),
            items: [for (final l in languages) DropdownMenuItem(value: l, child: Text(l))],
            onChanged: (v) => s.setLanguage(v!),
          ),
        ],
      ),
      const SizedBox(height: 18),
      if (s.error != null)
        Container(
          margin: const EdgeInsets.only(bottom: 14),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Palette.dangerSoft,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Palette.danger.withValues(alpha: 0.25)),
          ),
          child: Text(s.error!, style: const TextStyle(color: Palette.danger, fontSize: 14)),
        ),
      FilledButton(
        onPressed: s.running ? null : s.start,
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(s.running ? 'Working…' : 'Make my carousel'),
          if (!s.running) ...[const SizedBox(width: 8), const Icon(Icons.arrow_forward_rounded, size: 18)],
        ]),
      ),
      if (s.running) ...[
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: s.stop,
          icon: const Icon(Icons.stop_circle_outlined, size: 18),
          label: const Text('Stop'),
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(44), foregroundColor: Theme.of(context).colorScheme.error),
        ),
      ],
    ]);
  }
}

// On the hero the fields sit on a white card over the canvas; on the side they go bare.
class _Panel extends StatelessWidget {
  const _Panel({required this.hero, required this.children});
  final bool hero;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final column = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
    if (!hero) return column;
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Palette.border),
      ),
      child: column,
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
      );
}

class _Workspace extends StatelessWidget {
  const _Workspace({required this.state});
  final _StudioPageState state;

  @override
  Widget build(BuildContext context) {
    final s = state;
    if (s.runId == null) {
      return const Center(child: Text('Add your website to start: the agents read it, pick your logo, colors and photos, and make the carousel.'));
    }
    final plan = s.plan;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (s.siteAssets != null) ...[
          _SiteAssets(data: s.siteAssets!),
          const SizedBox(height: 16),
        ],
        if (plan != null) ...[
          Text(plan['concept'] as String? ?? '', style: Theme.of(context).textTheme.titleLarge),
          if (s.done != null) const Text('Tap a slide to ask the designer for changes.'),
          const SizedBox(height: 12),
          SizedBox(
            height: 300,
            child: _SlidesStrip(
              plan: plan,
              events: s.events,
              onEdit: s.done == null ? null : (n, url) => _openEditor(context, s, n, url),
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (s.done != null) _DoneCard(event: s.done!, runId: s.runId!, onReel: s.reels ? s.makeReel : null),
        const SizedBox(height: 8),
        Text('Agents at work', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        Expanded(
          child: ListView.builder(
            controller: s.timeline,
            itemCount: s.events.length,
            itemBuilder: (_, i) => _EventRow(event: s.events[i]),
          ),
        ),
      ]),
    );
  }
}

Future<void> _openEditor(BuildContext context, _StudioPageState s, int n, String url) async {
  final feedback = TextEditingController();
  final send = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('Edit slide $n'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: AspectRatio(aspectRatio: 4 / 5, child: Image.network(Api.fileUrl(url), fit: BoxFit.cover)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: feedback,
            autofocus: true,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'What should change?', hintText: 'Bigger headline, move the logo to the bottom right'),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Send to the designer')),
      ],
    ),
  );
  if (send == true && feedback.text.trim().isNotEmpty) await s.editSlide(n, feedback.text.trim());
}

const _brandKinds = {'logo'};
const _photoKinds = {'product', 'food', 'place', 'people', 'work', 'banner'};

class _SiteAssets extends StatelessWidget {
  const _SiteAssets({required this.data});
  final Map<String, dynamic> data;

  @override
  Widget build(BuildContext context) {
    final assets = (data['assets'] as List).cast<Map<String, dynamic>>();
    final colors = (data['colors'] as List).cast<String>();
    final brand = assets.where((a) => _brandKinds.contains(a['kind'])).toList();
    final photos = assets.where((a) => _photoKinds.contains(a['kind'])).toList();
    final other = assets.where((a) => !_brandKinds.contains(a['kind']) && !_photoKinds.contains(a['kind'])).toList();
    return SizedBox(
      height: 112,
      child: ListView(scrollDirection: Axis.horizontal, children: [
        _AssetGroup(
          title: 'Brand',
          assets: brand,
          extra: [for (final c in colors) _Swatch(hex: c)],
        ),
        _AssetGroup(title: 'Photos', assets: photos),
        _AssetGroup(title: 'Other assets', assets: other),
      ]),
    );
  }
}

class _AssetGroup extends StatelessWidget {
  const _AssetGroup({required this.title, required this.assets, this.extra = const []});
  final String title;
  final List<Map<String, dynamic>> assets;
  final List<Widget> extra;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$title (${assets.length})', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        Row(children: [
          for (final a in assets)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Tooltip(
                message: '${a['kind'] ?? ''}: ${a['description'] ?? ''}',
                child: InkWell(
                  onTap: () => showBig(context, NetworkImage(Api.fileUrl(a['url'] as String)), caption: '${a['kind'] ?? ''}: ${a['description'] ?? ''}'),
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(color: const Color(0xFFE5E5EA), borderRadius: BorderRadius.circular(8)),
                    clipBehavior: Clip.antiAlias,
                    child: Image.network(Api.fileUrl(a['url'] as String), fit: a['kind'] == 'logo' ? BoxFit.contain : BoxFit.cover),
                  ),
                ),
              ),
            ),
          ...extra,
          if (assets.isEmpty && extra.isEmpty) const Text('None found', style: TextStyle(color: Colors.black45)),
        ]),
      ]),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({required this.hex});
  final String hex;

  @override
  Widget build(BuildContext context) {
    final value = int.tryParse(hex.replaceFirst('#', ''), radix: 16) ?? 0;
    return Tooltip(
      message: hex,
      child: Container(
        width: 32,
        height: 72,
        margin: const EdgeInsets.only(right: 6),
        decoration: BoxDecoration(color: Color(0xFF000000 | value), borderRadius: BorderRadius.circular(8)),
      ),
    );
  }
}

class _SlidesStrip extends StatelessWidget {
  const _SlidesStrip({required this.plan, required this.events, this.onEdit});
  final Map<String, dynamic> plan;
  final List<RunEvent> events;
  final void Function(int n, String url)? onEdit;

  @override
  Widget build(BuildContext context) {
    final slides = (plan['slides'] as List).cast<Map<String, dynamic>>();
    return ListView.separated(
      scrollDirection: Axis.horizontal,
      itemCount: slides.length,
      separatorBuilder: (_, _) => const SizedBox(width: 12),
      itemBuilder: (_, i) {
        final n = slides[i]['n'] as int;
        final mine = events.where((e) => e.slide == n);
        final finalSlide = mine.where((e) => e.type == 'slide').lastOrNull;
        final review = mine.where((e) => e.type == 'review').lastOrNull;
        // While an edit is running, its snapshots are newer than the exported slide.
        final latest = mine.where((e) => e.type == 'slide' || e.type == 'snapshot').lastOrNull;
        final video = mine.where((e) => e.type == 'video').lastOrNull;
        final videoUrl = (video?.data as Map?)?['url'] as String?;
        final url = (latest?.data as Map?)?['url'] as String?;
        final finalUrl = (finalSlide?.data as Map?)?['url'] as String?;
        return AspectRatio(
          aspectRatio: 4 / 5,
          child: GestureDetector(
            // Tapping edits a finished slide; before that it shows the slide big.
            onTap: onEdit != null && finalUrl != null
                ? () => onEdit!(n, finalUrl)
                : url != null
                    ? () => showBig(context, NetworkImage(Api.fileUrl(url)), caption: 'Slide $n')
                    : null,
            child: Container(
            decoration: BoxDecoration(color: const Color(0xFFF3F3F6), borderRadius: BorderRadius.circular(12)),
            clipBehavior: Clip.antiAlias,
            child: Stack(fit: StackFit.expand, children: [
              if (videoUrl != null)
                _LoopVideo(url: Api.fileUrl(videoUrl), key: ValueKey(videoUrl))
              else if (url != null)
                Image.network(Api.fileUrl(url), fit: BoxFit.cover, key: ValueKey(url))
              else
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Center(child: Text(slides[i]['headline'] as String? ?? '', textAlign: TextAlign.center)),
                ),
              if (url != null)
                Positioned(
                  right: 6,
                  top: 6,
                  child: IconButton.filledTonal(
                    tooltip: 'See it big',
                    iconSize: 18,
                    visualDensity: VisualDensity.compact,
                    onPressed: () => showBig(context, NetworkImage(Api.fileUrl(finalUrl ?? url)), caption: 'Slide $n'),
                    icon: const Icon(Icons.zoom_in),
                  ),
                ),
              Positioned(
                left: 8,
                top: 8,
                child: _Badge(
                  label: finalSlide != null
                      ? ((finalSlide.data as Map)['approved'] == true ? 'Approved' : 'Kept')
                      : review != null
                          ? 'Critic: ${(review.data as Map)['score']}/10'
                          : '$n',
                  color: finalSlide != null ? agentColors['designer']! : Colors.black54,
                ),
              ),
            ]),
          ),
          ),
        );
      },
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(99)),
        child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 12)),
      );
}

// Any image big, with zoom: tap outside or the X to close.
void showBig(BuildContext context, ImageProvider image, {String? caption}) {
  showDialog<void>(
    context: context,
    barrierColor: Colors.black87,
    builder: (context) => Dialog.fullscreen(
      backgroundColor: Colors.transparent,
      child: Stack(children: [
        Positioned.fill(
          child: GestureDetector(
            onTap: () => Navigator.pop(context),
            child: InteractiveViewer(maxScale: 6, child: Center(child: Image(image: image, fit: BoxFit.contain))),
          ),
        ),
        Positioned(
          right: 16,
          top: 16,
          child: IconButton.filled(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
        ),
        if (caption != null && caption.isNotEmpty)
          Positioned(
            left: 16,
            right: 80,
            bottom: 16,
            child: Text(caption, style: const TextStyle(color: Colors.white, fontSize: 15)),
          ),
      ]),
    ),
  );
}

class _DoneCard extends StatelessWidget {
  const _DoneCard({required this.event, required this.runId, required this.onReel});
  final RunEvent event;
  final String runId;
  final VoidCallback? onReel;

  @override
  Widget build(BuildContext context) {
    final data = event.data as Map<String, dynamic>;
    final caption = '${data['caption']}\n\n${hashtagsOf(data['hashtags']).join(' ')}';
    return Card(
      color: const Color(0xFFEAF7F2),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(
            data['cost'] is num ? 'Your carousel is ready · US\$${(data['cost'] as num).toStringAsFixed(2)}' : 'Your carousel is ready',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          if (data['reel'] is String)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(
                  width: 180,
                  child: AspectRatio(
                    aspectRatio: 9 / 16,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: _LoopVideo(url: Api.fileUrl(data['reel'] as String), key: ValueKey(data['reel'])),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(child: SelectableText(caption)),
              ]),
            )
          else
            SelectableText(caption),
          const SizedBox(height: 12),
          Wrap(spacing: 8, children: [
            OutlinedButton.icon(
              icon: const Icon(Icons.copy, size: 16),
              label: const Text('Copy caption'),
              onPressed: () => Clipboard.setData(ClipboardData(text: caption)),
            ),
            // One reel from the whole carousel; the slides are not animated one by one.
            if (onReel != null)
              FilledButton.icon(
                icon: const Icon(Icons.movie_creation_outlined, size: 16),
                label: Text(data['reel'] == null ? 'Make the 30 s reel' : 'Make the reel again'),
                onPressed: onReel,
              ),
            OutlinedButton.icon(
              icon: const Icon(Icons.download, size: 16),
              label: const Text('Download everything (ZIP)'),
              onPressed: () => _download(Api.fileUrl('/api/runs/$runId/download')),
            ),
          ]),
        ]),
      ),
    );
  }
}

// One file through a link: opening several windows gets all but the first blocked.
void _download(String url) {
  final a = web.HTMLAnchorElement()
    ..href = url
    ..download = '';
  web.document.body!.append(a);
  a.click();
  a.remove();
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event});
  final RunEvent event;

  @override
  Widget build(BuildContext context) {
    final color = agentColors[event.agent] ?? Colors.grey;
    final mono = event.type == 'tool';
    final data = event.data;
    final image = data is Map ? data['url'] as String? : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
          width: 86,
          child: Text(event.agent, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
        ),
        if (event.slide != null) SizedBox(width: 28, child: Text('#${event.slide}', style: const TextStyle(color: Colors.black45))),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              event.text,
              style: TextStyle(
                fontFamily: mono ? 'monospace' : null,
                fontSize: mono ? 12 : 14,
                color: event.type == 'error' ? Theme.of(context).colorScheme.error : null,
              ),
            ),
            if (event.type == 'review' && data is Map && data['checks'] is Map)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final MapEntry(:key, :value) in (data['checks'] as Map).entries)
                    Tooltip(
                      message: (value as Map)['note']?.toString() ?? '',
                      child: Chip(
                        visualDensity: VisualDensity.compact,
                        label: Text(
                          '${value['answer'] == 'yes' ? '✓' : value['answer'] == 'no' ? '✗' : '–'} ${key.toString().replaceAll('_', ' ')}',
                          style: TextStyle(fontSize: 12, color: value['answer'] == 'no' ? Theme.of(context).colorScheme.error : null),
                        ),
                      ),
                    ),
                ]),
              ),
            // Snapshots of each round and assets made with Muse Image.
            if (image != null && event.type != 'slide')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: InkWell(
                  onTap: () => showBig(context, NetworkImage(Api.fileUrl(image)), caption: event.text),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: Image.network(Api.fileUrl(image), height: 120),
                  ),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
