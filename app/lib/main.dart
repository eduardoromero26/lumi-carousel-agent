import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'dart:ui_web' as ui_web;
import 'package:web/web.dart' as web;

import 'api.dart';
import 'feed.dart';
import 'gallery.dart';
import 'i18n.dart';
import 'queue.dart';
import 'room.dart';

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
  static const ground = Color(0xFFF4F3F8);
  static const divider = Color(0xFFECEAF3);
  static const navActive = Color(0xFFF1EEFF);
  static const hoverSoft = Color(0xFFF6F5FA);
  static const kicker = Color(0xFF5B3FD9);
  static const success = Color(0xFF0E8A6A);
  static const successSoft = Color(0xFFE7F6F0);
  static const danger = Color(0xFFB42318);
  static const dangerSoft = Color(0xFFFEF3F2);
}

TextStyle mono({double size = 12, Color color = Palette.muted, FontWeight weight = FontWeight.w500, double spacing = 0}) =>
    GoogleFonts.jetBrainsMono(fontSize: size, color: color, fontWeight: weight, letterSpacing: spacing, height: 1.45);

class CarouselAgentApp extends StatelessWidget {
  const CarouselAgentApp({super.key});

  @override
  Widget build(BuildContext context) {
    final rounded = RoundedRectangleBorder(borderRadius: BorderRadius.circular(10));
    OutlineInputBorder field(Color color, [double width = 1]) =>
        OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: color, width: width));
    const label = TextStyle(fontWeight: FontWeight.w700, fontSize: 15);
    return MaterialApp(
      title: 'Lumi',
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
        // Every modal as Lumi's: white, a thin border, no Material tint or shadow.
        dialogTheme: DialogThemeData(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          barrierColor: const Color(0x991B1540),
          insetPadding: const EdgeInsets.all(24),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: Palette.border)),
          titleTextStyle: GoogleFonts.plusJakartaSans(fontSize: 19, fontWeight: FontWeight.w800, color: Palette.ink, letterSpacing: -0.2),
          contentTextStyle: GoogleFonts.plusJakartaSans(fontSize: 14, color: Palette.ink, height: 1.45),
          actionsPadding: const EdgeInsets.fromLTRB(24, 4, 24, 20),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(minimumSize: const Size(0, 44), padding: const EdgeInsets.symmetric(horizontal: 16), shape: rounded, foregroundColor: Palette.muted, textStyle: label),
        ),
      ),
      // ?view=room: the agents' room, a screen of its own for watching a run. A new language
      // builds the app again from the top, so no const widget keeps the old words.
      home: ValueListenableBuilder<String>(
        valueListenable: appLanguage,
        builder: (context, lang, _) => KeyedSubtree(key: ValueKey(lang), child: Uri.base.queryParameters['view'] == 'room' ? const RoomPage() : const HomeShell()),
      ),
    );
  }
}

// Create (the studio where the agents work), Feed (every carousel as it would look on
// Instagram), Queue (many websites in a row) and Design it live (the agents at work).
// ?view=feed|queue|live opens that tab; ?run=<id> opens that run in Create.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int tab = const {'feed': 1, 'queue': 2, 'live': 3}[Uri.base.queryParameters['view']] ?? 0;

  // Create is the normal view of a run; its edit view is Design it live.
  void watchEdit() {
    if (editRun.value != null && mounted) setState(() => tab = 3);
  }

  @override
  void initState() {
    super.initState();
    editRun.addListener(watchEdit);
    final id = Uri.base.queryParameters['run'];
    if (id != null && id.isNotEmpty) WidgetsBinding.instance.addPostFrameCallback((_) => openEditView(id));
  }

  @override
  void dispose() {
    editRun.removeListener(watchEdit);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget tabButton(int i, IconData icon, String label) {
      final on = tab == i;
      final color = on ? Palette.ink : Palette.muted;
      return Padding(
        padding: const EdgeInsets.only(right: 2),
        child: Material(
          color: on ? Palette.navActive : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            hoverColor: Palette.hoverSoft,
            onTap: () => setState(() => tab = i),
            child: Container(
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 19, color: color),
                const SizedBox(width: 7),
                Text(label, style: TextStyle(fontSize: 14.5, fontWeight: on ? FontWeight.w700 : FontWeight.w500, color: color)),
              ]),
            ),
          ),
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Column(children: [
          // Design it live is full screen, like Lumi's creator: its own close button brings the menu back.
          if (tab != 3)
          Container(
            height: 64,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Palette.divider))),
            child: Row(children: [
              // Lumi's brand: its logo opens the app.
              Image.asset('assets/lumi-logo.png', height: 30),
              const SizedBox(width: 18),
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(children: [
                    tabButton(0, Icons.auto_awesome_outlined, 'Create'.tr),
                    tabButton(1, Icons.dynamic_feed_outlined, 'Feed'.tr),
                  ]),
                ),
              ),
              const LanguageToggle(),
            ]),
          ),
          Expanded(
            child: IndexedStack(index: tab, children: [
              const StudioPage(),
              FeedPage(active: tab == 1),
              QueuePage(active: tab == 2),
              RoomPage(embedded: true, active: tab == 3, onExit: () => setState(() => tab = 0)),
            ]),
          ),
          if (tab != 3) const _PoweredBy(),
        ]),
      ),
    );
  }
}

const kodemexUrl = 'https://kodemex.com.mx';

// EN | ES in the header: the whole UI changes language and the choice is remembered.
class LanguageToggle extends StatelessWidget {
  const LanguageToggle({super.key});

  @override
  Widget build(BuildContext context) {
    final now = appLanguage.value;
    Widget option(String lang, String label) {
      final on = now == lang;
      return InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: on ? null : () => setLanguage(lang),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
          decoration: BoxDecoration(color: on ? Palette.primary : Colors.transparent, borderRadius: BorderRadius.circular(999)),
          child: Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: 0.4, color: on ? Colors.white : Palette.muted)),
        ),
      );
    }

    return Tooltip(
      message: now == 'es' ? 'Language' : 'Idioma',
      child: Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: Palette.border)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [option('en', 'EN'), option('es', 'ES')]),
      ),
    );
  }
}

class _PoweredBy extends StatelessWidget {
  const _PoweredBy();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36,
      decoration: const BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: Palette.divider))),
      alignment: Alignment.center,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () => web.window.open(kodemexUrl, '_blank'),
          child: Text.rich(
            TextSpan(style: const TextStyle(fontSize: 12.5, color: Palette.faint), children: [
              const TextSpan(text: 'Open source · Powered by '),
              TextSpan(text: 'Kodemex', style: const TextStyle(fontWeight: FontWeight.w700, color: Palette.primary)),
            ]),
          ),
        ),
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
  final scaffold = GlobalKey<ScaffoldState>();
  String language = web.window.navigator.language.startsWith('es') ? 'Español' : 'English';
  String? runId;
  String? error;
  StreamSubscription<RunEvent>? sub;
  // Off on the server (REELS) until a reel takes less than a run.
  bool reels = false;
  // The style gallery and the style this carousel follows (null: the agents decide).
  List<Map<String, dynamic>> styles = [];
  String? reference;
  bool uploading = false;
  // The first screen: 0 the website, 1 the style.
  int startStep = 0;

  Map<String, dynamic>? get chosenStyle => styles.where((s) => s['id'] == reference).firstOrNull;

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
    normalRun.addListener(showNormal);
    Api.config().then((c) {
      if (mounted) setState(() => reels = c['reels'] == true);
    }, onError: (_) {});
    loadStyles();
  }

  Future<void> loadStyles() async {
    try {
      final list = await Api.references();
      if (mounted) setState(() => styles = list);
    } catch (_) {}
  }

  void chooseStyle(String? id) => setState(() => reference = id);

  // Each design is read by a vision model on the server, one after another.
  Future<void> uploadStyles() async {
    final images = await pickImages();
    if (images.isEmpty) return;
    setState(() {
      uploading = true;
      error = null;
    });
    try {
      for (final (name, base64) in images) {
        final added = await Api.addReference(name, base64);
        if (mounted) setState(() => styles = [added, ...styles]);
      }
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  Future<void> deleteStyle(String id) async {
    try {
      await Api.deleteReference(id);
      setState(() {
        styles = styles.where((s) => s['id'] != id).toList();
        if (reference == id) reference = null;
      });
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  void refresh() => setState(() {});

  void setStartStep(int step) => setState(() => startStep = step);

  void setLanguage(String value) => setState(() => language = value);

  @override
  void dispose() {
    normalRun.removeListener(showNormal);
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
        reference: reference,
      );
      scaffold.currentState?.closeDrawer();
      liveRun.value = id;
      // The agents' work is watched in the edit view; Create is ready for the next one.
      openEditView(id);
      setState(() {
        startStep = 0;
        website.clear();
      });
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  // The edit view's "Normal": its run here, and in the URL so a reload keeps it.
  void showNormal() {
    final id = normalRun.value;
    if (id == null || !mounted) return;
    if (id != runId) listen(id);
    web.window.history.replaceState(null, '', '${Uri.base.origin}${Uri.base.path}?run=$id');
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
    });
  }

  void openAgentWork() => scaffold.currentState?.openEndDrawer();

  void openNewCarousel() => scaffold.currentState?.openDrawer();

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
    // Before a run, the brief is the whole page; once the agents work, it moves to the side.
    if (runId == null) return _Start(state: this);
    final narrow = MediaQuery.sizeOf(context).width < 720;
    return Scaffold(
      key: scaffold,
      backgroundColor: Palette.ground,
      // A new carousel: the same brief, out of the way while the agents work.
      drawer: Drawer(
        width: MediaQuery.sizeOf(context).width.clamp(0, 420).toDouble(),
        backgroundColor: Colors.white,
        shape: const RoundedRectangleBorder(),
        child: SafeArea(
          child: Stack(children: [
            SingleChildScrollView(padding: const EdgeInsets.fromLTRB(24, 28, 24, 24), child: _BriefForm(state: this)),
            Positioned(
              right: 8,
              top: 8,
              child: IconButton(tooltip: 'Close', onPressed: () => scaffold.currentState?.closeDrawer(), icon: const Icon(Icons.close_rounded)),
            ),
          ]),
        ),
      ),
      drawerEnableOpenDragGesture: false,
      // What every agent did, step by step: a debug view, out of the owner's way.
      endDrawer: _AgentWork(events: events, running: running),
      endDrawerEnableOpenDragGesture: false,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.all(narrow ? 16 : 24),
          child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1180), child: _Workspace(state: this))),
        ),
      ),
    );
  }
}

// White, thin border, no shadow: every block of the run view.
class _Card extends StatelessWidget {
  const _Card({required this.child, this.title, this.subtitle, this.trailing});
  final Widget child;
  final String? title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (title != null) ...[
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title!, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, height: 1.3)),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(subtitle!, style: const TextStyle(fontSize: 13, color: Palette.faint, height: 1.4)),
                ],
              ]),
            ),
            ?trailing,
          ]),
          const SizedBox(height: 14),
        ],
        child,
      ]),
    );
  }
}

class _BriefForm extends StatelessWidget {
  // ignore: unused_element_parameter
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
          const SizedBox(height: 18),
          const _FieldLabel('Style'),
          _ChosenStyle(state: s, hero: hero),
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
      if (s.running && !hero) ...[
        const SizedBox(height: 8),
        const Text('One carousel at a time: stop the current one or wait until it is ready.', style: TextStyle(color: Palette.faint, fontSize: 13)),
      ],
    ]);
  }
}

// The style the carousel follows, picked in the gallery below the form.
class _ChosenStyle extends StatelessWidget {
  const _ChosenStyle({required this.state, required this.hero});
  final _StudioPageState state;
  final bool hero;

  @override
  Widget build(BuildContext context) {
    final style = state.chosenStyle;
    if (style == null) {
      return Text(hero ? 'The agents decide. Pick a style in the gallery below.' : 'The agents decide.', style: const TextStyle(color: Palette.faint, fontSize: 13));
    }
    return Row(children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image.network(Api.fileUrl(style['url'] as String), width: 40, height: 50, fit: BoxFit.cover),
      ),
      const SizedBox(width: 12),
      Expanded(child: Text(style['title'] as String, style: const TextStyle(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
      if (!state.running) IconButton(tooltip: 'Let the agents decide', onPressed: () => state.chooseStyle(null), icon: const Icon(Icons.close, size: 18)),
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
    final plan = s.plan;
    final error = s.events.where((e) => e.type == 'error').lastOrNull;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _RunHeader(state: s),
      if (error != null) ...[
        const SizedBox(height: 16),
        _ErrorCard(state: s, error: error, planned: plan != null),
      ],
      if (plan == null && s.running) ...[
        const SizedBox(height: 16),
        _Card(
          title: 'Your carousel',
          subtitle: s.siteAssets == null
              ? 'The analyst is reading your website. Then the director plans the slides.'
              : 'The director is planning the slides from what the analyst found.',
          child: const _SlidesLoading(),
        ),
      ],
      if (plan != null) ...[
        const SizedBox(height: 16),
        _Card(
          title: 'Your carousel',
          subtitle: s.done != null ? 'Tap a slide to ask the designer for changes.' : 'Each slide shows up as the designer builds it and the critic checks it.',
          child: _SlidesStrip(
            plan: plan,
            events: s.events,
            onEdit: s.done == null ? null : (n, url) => _openEditor(context, s, n, url),
          ),
        ),
      ],
      if (s.done != null) ...[
        const SizedBox(height: 16),
        _DoneCard(event: s.done!, runId: s.runId!, onReel: s.reels ? s.makeReel : null),
      ],
      if (s.siteAssets != null) ...[
        const SizedBox(height: 16),
        _SiteAssets(data: s.siteAssets!),
      ] else if (s.running) ...[
        const SizedBox(height: 16),
        const _Card(
          title: 'Found on your website',
          subtitle: 'Your logo, colors and photos show up here.',
          child: _AssetsLoading(),
        ),
      ],
    ]);
  }
}

// A soft pulse for what is on its way.
class _Pulse extends StatefulWidget {
  const _Pulse({required this.child});
  final Widget child;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))..repeat(reverse: true);

  @override
  void dispose() {
    pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: Tween(begin: 0.45, end: 1.0).animate(pulse), child: widget.child);
}

// Five empty slides, laid out like the real ones, until the plan arrives.
class _SlidesLoading extends StatelessWidget {
  const _SlidesLoading();

  @override
  Widget build(BuildContext context) {
    const gap = 12.0, count = 5;
    return LayoutBuilder(builder: (context, box) {
      final columns = ((box.maxWidth + gap) / (150 + gap)).floor().clamp(2, count);
      final width = (box.maxWidth - gap * (columns - 1)) / columns;
      return _Pulse(
        child: Wrap(spacing: gap, runSpacing: gap, children: [
          for (var i = 0; i < count; i++)
            SizedBox(
              width: width,
              child: AspectRatio(
                aspectRatio: 4 / 5,
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: Palette.ground, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.border)),
                  child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    for (final w in [0.8, 0.55]) ...[
                      FractionallySizedBox(
                        widthFactor: w,
                        child: Container(height: 10, decoration: BoxDecoration(color: Palette.border, borderRadius: BorderRadius.circular(99))),
                      ),
                      const SizedBox(height: 8),
                    ],
                  ]),
                ),
              ),
            ),
        ]),
      );
    });
  }
}

class _AssetsLoading extends StatelessWidget {
  const _AssetsLoading();

  @override
  Widget build(BuildContext context) => _Pulse(
        child: Wrap(spacing: 6, runSpacing: 6, children: [
          for (var i = 0; i < 10; i++)
            Container(width: 40, height: 40, decoration: BoxDecoration(color: Palette.ground, borderRadius: BorderRadius.circular(5), border: Border.all(color: Palette.border))),
        ]),
      );
}

// The run stopped: what happened in plain words, the raw reason for whoever debugs it,
// and the way out.
class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.state, required this.error, required this.planned});
  final _StudioPageState state;
  final RunEvent error;
  final bool planned;

  @override
  Widget build(BuildContext context) {
    final s = state;
    final stopped = error.text.startsWith('Stopped by the owner');
    final title = stopped ? 'You stopped this carousel' : 'The agents could not finish this carousel';
    final body = stopped
        ? 'Nothing else will be made for this run. Start a new one when you are ready.'
        : planned
            ? 'The slides made so far are below. Try again, or see in the agents\' log where it stopped.'
            : 'It stopped before the slides were planned. Check that the website opens, then try again.';
    final canRetry = s.website.text.trim().isNotEmpty;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.danger.withValues(alpha: 0.3))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 40,
          height: 40,
          decoration: const BoxDecoration(color: Palette.dangerSoft, shape: BoxShape.circle),
          child: Icon(stopped ? Icons.stop_rounded : Icons.error_outline_rounded, color: Palette.danger, size: 22),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, height: 1.3)),
            const SizedBox(height: 4),
            Text(body, style: const TextStyle(fontSize: 14, color: Palette.muted, height: 1.45)),
            if (!stopped) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Palette.canvas, borderRadius: BorderRadius.circular(8), border: Border.all(color: Palette.border)),
                child: SelectableText(error.text, style: mono(size: 12, color: Palette.danger)),
              ),
            ],
            const SizedBox(height: 14),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (canRetry)
                FilledButton.icon(
                  onPressed: s.start,
                  icon: const Icon(Icons.refresh_rounded, size: 18),
                  label: const Text('Try again'),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                )
              else
                FilledButton.icon(
                  onPressed: s.openNewCarousel,
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('New carousel'),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                ),
              OutlinedButton.icon(
                onPressed: s.openAgentWork,
                icon: const Icon(Icons.terminal_rounded, size: 18),
                label: const Text('See what happened'),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }
}

// Where the run is: the agency's steps, what is happening right now and the way into
// the agents' log.
class _RunHeader extends StatelessWidget {
  const _RunHeader({required this.state});
  final _StudioPageState state;

  @override
  Widget build(BuildContext context) {
    final s = state;
    final events = s.events;
    final error = events.where((e) => e.type == 'error').lastOrNull;
    final now = events.where((e) => const {'status', 'thought', 'review', 'slide', 'assets'}.contains(e.type)).lastOrNull;
    final (label, color) = error != null
        ? ('STOPPED', Palette.danger)
        : s.done != null
            ? ('READY', Palette.success)
            : ('WORKING', Palette.kicker);
    final title = s.plan?['concept'] as String? ?? (s.done != null || error != null ? 'Your carousel' : 'Reading your website…');
    final narrow = MediaQuery.sizeOf(context).width < 720;
    final actions = Wrap(spacing: 8, runSpacing: 8, children: [
      if (s.running)
        OutlinedButton.icon(
          onPressed: s.stop,
          icon: const Icon(Icons.stop_circle_outlined, size: 18),
          label: const Text('Stop'),
          style: OutlinedButton.styleFrom(foregroundColor: Palette.danger),
        ),
      ViewSwitch(edit: false, onChanged: (on) {
        if (on) openEditView(s.runId!);
      }),
      OutlinedButton.icon(
        onPressed: s.openAgentWork,
        icon: const Icon(Icons.terminal_rounded, size: 18),
        label: Text('Agent work · ${events.length}'),
      ),
      FilledButton.icon(
        onPressed: s.openNewCarousel,
        icon: const Icon(Icons.add_rounded, size: 18),
        label: const Text('New carousel'),
        style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
      ),
    ]);
    return _Card(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                if (s.running) ...[const _LiveDot(), const SizedBox(width: 8)],
                Text(label, style: mono(color: color, spacing: 1.6)),
              ]),
              const SizedBox(height: 6),
              Text(title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1.2, letterSpacing: -0.2)),
              if (now != null && s.running) ...[
                const SizedBox(height: 8),
                Text.rich(
                  TextSpan(children: [
                    TextSpan(text: '${_agentName(now.agent)}  ', style: TextStyle(fontWeight: FontWeight.w700, color: agentColors[now.agent] ?? Palette.muted)),
                    TextSpan(text: now.text.split('\n').first),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, color: Palette.muted),
                ),
              ],
            ]),
          ),
          if (!narrow) ...[const SizedBox(width: 16), actions],
        ]),
        if (narrow) ...[const SizedBox(height: 14), actions],
        const SizedBox(height: 18),
        const Divider(),
        const SizedBox(height: 16),
        _Steps(steps: _flow(events, s.plan, error != null)),
      ]),
    );
  }
}

String _agentName(String agent) => agent.isEmpty ? '' : '${agent[0].toUpperCase()}${agent.substring(1)}';

class _LiveDot extends StatefulWidget {
  const _LiveDot();

  @override
  State<_LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<_LiveDot> with SingleTickerProviderStateMixin {
  late final pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);

  @override
  void dispose() {
    pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 0.35, end: 1.0).animate(pulse),
        child: Container(width: 8, height: 8, decoration: const BoxDecoration(color: Palette.primary, shape: BoxShape.circle)),
      );
}

enum _StepState { pending, active, done, failed }

typedef _Step = ({String label, _StepState state});

// The agency's steps (docs/SCOPE.md), read from the run's events: everything before the
// current step is done, one step is current, the rest wait. The owner's changes come
// after delivery, from the slides.
List<_Step> _flow(List<RunEvent> ev, Map<String, dynamic>? plan, bool failed) {
  final total = (plan?['slides'] as List?)?.length ?? 0;
  final slidesDone = ev.where((e) => e.type == 'slide').map((e) => e.slide).toSet().length;
  final finished = ev.any((e) => e.type == 'done');
  final done = [
    ev.any((e) => e.type == 'assets') || plan != null,
    plan != null,
    ev.any((e) => e.slide != null),
    total > 0 && slidesDone >= total,
    finished,
    finished,
  ];
  const labels = ['Read the website', 'Plan', 'Art direction', 'Design in GIMP', 'Review', 'Ready'];
  final current = finished ? -1 : done.indexOf(false);
  return [
    for (var i = 0; i < labels.length; i++)
      (
        label: labels[i],
        state: finished || i < current
            ? _StepState.done
            : i == current
                ? (failed ? _StepState.failed : _StepState.active)
                : _StepState.pending,
      ),
  ];
}

class _Steps extends StatelessWidget {
  const _Steps({required this.steps});
  final List<_Step> steps;

  @override
  Widget build(BuildContext context) {
    final current = steps.indexWhere((s) => s.state == _StepState.active || s.state == _StepState.failed);
    return LayoutBuilder(builder: (context, box) {
      // Too narrow for the row: where the run is, in one line and a bar.
      if (box.maxWidth < 640) {
        final n = current < 0 ? steps.length : current + 1;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Step $n of ${steps.length} · ${steps[n - 1].label}', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(99),
            child: LinearProgressIndicator(value: n / steps.length, minHeight: 6, backgroundColor: Palette.ground),
          ),
        ]);
      }
      return Row(children: [
        for (var i = 0; i < steps.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 2,
                margin: const EdgeInsets.symmetric(horizontal: 10),
                color: steps[i].state == _StepState.pending ? Palette.border : Palette.primary,
              ),
            ),
          _StepItem(n: i + 1, step: steps[i]),
        ],
      ]);
    });
  }
}

class _StepItem extends StatelessWidget {
  const _StepItem({required this.n, required this.step});
  final int n;
  final _Step step;

  @override
  Widget build(BuildContext context) {
    final (fill, border) = switch (step.state) {
      _StepState.done => (Palette.primarySoft, Palette.primarySoft),
      _StepState.active => (Palette.primary, Palette.primary),
      _StepState.failed => (Palette.dangerSoft, Palette.danger),
      _StepState.pending => (Colors.white, Palette.border),
    };
    final current = step.state == _StepState.active || step.state == _StepState.failed;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 24,
        height: 24,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: fill, shape: BoxShape.circle, border: Border.all(color: border, width: 1.5)),
        child: switch (step.state) {
          _StepState.done => const Icon(Icons.check_rounded, size: 15, color: Palette.primary),
          _StepState.failed => const Icon(Icons.close_rounded, size: 15, color: Palette.danger),
          _StepState.active => Text('$n', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.white)),
          _StepState.pending => Text('$n', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Palette.faint)),
        },
      ),
      const SizedBox(width: 8),
      Text(
        step.label,
        style: TextStyle(
          fontSize: 13.5,
          fontWeight: current ? FontWeight.w700 : FontWeight.w500,
          color: step.state == _StepState.failed ? Palette.danger : step.state == _StepState.pending ? Palette.faint : Palette.ink,
        ),
      ),
    ]);
  }
}

// The agents' log as a debug drawer: every status, tool call, review and snapshot.
class _AgentWork extends StatefulWidget {
  const _AgentWork({required this.events, required this.running});
  final List<RunEvent> events;
  final bool running;

  @override
  State<_AgentWork> createState() => _AgentWorkState();
}

class _AgentWorkState extends State<_AgentWork> {
  String? agent;

  @override
  Widget build(BuildContext context) {
    final agents = widget.events.map((e) => e.agent).toSet().toList();
    final shown = agent == null ? widget.events : widget.events.where((e) => e.agent == agent).toList();
    Widget filter(String? value, String label) {
      final on = agent == value;
      return ChoiceChip(
        label: Text(label),
        selected: on,
        showCheckmark: false,
        onSelected: (_) => setState(() => agent = value),
        labelStyle: TextStyle(fontSize: 13, fontWeight: on ? FontWeight.w700 : FontWeight.w500, color: on ? Palette.ink : Palette.muted),
        selectedColor: Palette.navActive,
        side: BorderSide(color: on ? Palette.navActive : Palette.border),
        visualDensity: VisualDensity.compact,
      );
    }

    return Drawer(
      width: MediaQuery.sizeOf(context).width.clamp(0, 600).toDouble(),
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 18, 12, 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    if (widget.running) ...[const _LiveDot(), const SizedBox(width: 8)],
                    Text('DEBUG', style: mono(color: Palette.kicker, spacing: 1.6)),
                  ]),
                  const SizedBox(height: 4),
                  const Text('Agent work', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1.2)),
                  const SizedBox(height: 2),
                  Text('${widget.events.length} events · newest first', style: const TextStyle(fontSize: 13, color: Palette.faint)),
                ]),
              ),
              IconButton(tooltip: 'Close', onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close_rounded)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 12),
            child: Wrap(spacing: 6, runSpacing: 6, children: [
              filter(null, 'All'),
              for (final a in agents) filter(a, _agentName(a)),
            ]),
          ),
          const Divider(),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
              itemCount: shown.length,
              separatorBuilder: (_, _) => const Divider(color: Palette.divider),
              itemBuilder: (_, i) => _EventRow(event: shown[shown.length - 1 - i]),
            ),
          ),
        ]),
      ),
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

class _SiteAssets extends StatefulWidget {
  const _SiteAssets({required this.data});
  final Map<String, dynamic> data;

  @override
  State<_SiteAssets> createState() => _SiteAssetsState();
}

class _SiteAssetsState extends State<_SiteAssets> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final assets = (widget.data['assets'] as List).cast<Map<String, dynamic>>();
    final colors = (widget.data['colors'] as List).cast<String>();
    final brand = assets.where((a) => _brandKinds.contains(a['kind'])).toList();
    final photos = assets.where((a) => _photoKinds.contains(a['kind'])).toList();
    final other = assets.where((a) => !_brandKinds.contains(a['kind']) && !_photoKinds.contains(a['kind'])).toList();
    // The big view walks through every asset in this order.
    final all = [...brand, ...photos, ...other];
    final gallery = [for (final a in all) _imageOf(a)];
    Widget thumb(Map<String, dynamic> a, double size) => _Thumb(asset: a, size: size, gallery: gallery, index: all.indexOf(a));
    Widget group(String title, List<Map<String, dynamic>> items, [List<Widget> extra = const []]) =>
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$title · ${items.length}', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Palette.muted)),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final a in items) thumb(a, 72),
            ...extra,
            if (items.isEmpty && extra.isEmpty) const Text('None found', style: TextStyle(color: Palette.faint, fontSize: 13)),
          ]),
        ]);
    final summary = [
      brand.isEmpty ? 'no logo' : 'logo',
      '${colors.length} color${colors.length == 1 ? '' : 's'}',
      '${photos.length} photo${photos.length == 1 ? '' : 's'}',
    ].join(' · ');
    return _Card(
      title: 'Found on your website',
      subtitle: 'The carousel uses only this: $summary.',
      trailing: TextButton(onPressed: () => setState(() => open = !open), child: Text(open ? 'Hide' : 'See all')),
      child: open
          ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              group('Brand', brand, [for (final c in colors) _Swatch(hex: c)]),
              const SizedBox(height: 16),
              group('Photos', photos),
              if (other.isNotEmpty) ...[const SizedBox(height: 16), group('Other assets', other)],
            ])
          : LayoutBuilder(builder: (context, box) {
              // One row of small thumbnails: as many as fit, then how many more.
              const size = 40.0, gap = 6.0;
              final fit = ((box.maxWidth - colors.length * (20 + gap) - 60) / (size + gap)).floor().clamp(0, 99);
              final shown = [...brand, ...photos].take(fit).toList();
              final rest = brand.length + photos.length - shown.length;
              return Wrap(spacing: gap, runSpacing: gap, crossAxisAlignment: WrapCrossAlignment.center, children: [
                for (final c in colors) _Swatch(hex: c, width: 20, height: size),
                for (final a in shown) thumb(a, size),
                if (rest > 0) Text('+$rest', style: const TextStyle(color: Palette.faint, fontSize: 13, fontWeight: FontWeight.w600)),
              ]);
            }),
    );
  }
}

BigImage _imageOf(Map<String, dynamic> a) =>
    (image: NetworkImage(Api.fileUrl(a['url'] as String)), caption: '${a['kind'] ?? ''}: ${a['description'] ?? ''}');

class _Thumb extends StatelessWidget {
  const _Thumb({required this.asset, required this.size, required this.gallery, required this.index});
  final Map<String, dynamic> asset;
  final double size;
  final List<BigImage> gallery;
  final int index;

  @override
  Widget build(BuildContext context) {
    final a = asset;
    return Tooltip(
      message: gallery[index].caption,
      child: InkWell(
        onTap: () => showImages(context, gallery, index),
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: Palette.ground, borderRadius: BorderRadius.circular(size / 9), border: Border.all(color: Palette.border)),
          clipBehavior: Clip.antiAlias,
          child: Image.network(Api.fileUrl(a['url'] as String), fit: a['kind'] == 'logo' ? BoxFit.contain : BoxFit.cover),
        ),
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({required this.hex, this.width = 32, this.height = 72});
  final String hex;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final value = int.tryParse(hex.replaceFirst('#', ''), radix: 16) ?? 0;
    return Tooltip(
      message: hex,
      child: Container(
        width: width,
        height: height,
        decoration: BoxDecoration(color: Color(0xFF000000 | value), borderRadius: BorderRadius.circular(height / 9), border: Border.all(color: Palette.border)),
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
    // The whole set in view, as the critic sees it: one row while a slide stays 150 px
    // or wider, then as many columns as fit.
    const gap = 12.0;
    return LayoutBuilder(builder: (context, box) {
      final fit = ((box.maxWidth + gap) / (150 + gap)).floor();
      final columns = fit.clamp(2, slides.isEmpty ? 2 : slides.length);
      final width = (box.maxWidth - gap * (columns - 1)) / columns;
      return Wrap(spacing: gap, runSpacing: gap, children: [
        for (var i = 0; i < slides.length; i++) SizedBox(width: width, child: tile(context, slides, i)),
      ]);
    });
  }

  // The newest image of each slide that has one, for the big view.
  List<(int, BigImage)> gallery(List<Map<String, dynamic>> slides) => [
        for (final slide in slides)
          if (events.where((e) => e.slide == slide['n'] && (e.type == 'slide' || e.type == 'snapshot')).lastOrNull case final e?)
            if ((e.data as Map?)?['url'] case final String url) (slide['n'] as int, (image: NetworkImage(Api.fileUrl(url)), caption: 'Slide ${slide['n']}')),
      ];

  void showSlide(BuildContext context, List<Map<String, dynamic>> slides, int n) {
    final all = gallery(slides);
    final at = all.indexWhere((g) => g.$1 == n);
    if (at >= 0) showImages(context, [for (final g in all) g.$2], at);
  }

  Widget tile(BuildContext context, List<Map<String, dynamic>> slides, int i) {
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
                    ? () => showSlide(context, slides, n)
                    : null,
            child: Container(
            decoration: BoxDecoration(color: Palette.ground, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.border)),
            clipBehavior: Clip.antiAlias,
            child: Stack(fit: StackFit.expand, children: [
              if (videoUrl != null)
                _LoopVideo(url: Api.fileUrl(videoUrl), key: ValueKey(videoUrl))
              else if (url != null)
                Image.network(Api.fileUrl(url), fit: BoxFit.cover, key: ValueKey(url))
              else
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Center(
                    child: Text(
                      slides[i]['headline'] as String? ?? '',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Palette.muted, height: 1.3),
                    ),
                  ),
                ),
              if (url != null)
                Positioned(
                  right: 6,
                  top: 6,
                  child: IconButton.filledTonal(
                    tooltip: 'See it big',
                    iconSize: 18,
                    visualDensity: VisualDensity.compact,
                    onPressed: () => showSlide(context, slides, n),
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
                  color: finalSlide != null
                      ? ((finalSlide.data as Map)['approved'] == true ? Palette.success : Palette.muted)
                      : Palette.ink.withValues(alpha: 0.72),
                ),
              ),
            ]),
          ),
          ),
        );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(99)),
        child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
      );
}

typedef BigImage = ({ImageProvider image, String caption});

// Any image big, with zoom: tap outside or the X to close.
void showBig(BuildContext context, ImageProvider image, {String? caption}) => showImages(context, [(image: image, caption: caption ?? '')], 0);

// Several images big, like a carousel: arrows or the keyboard's ← → move between them.
void showImages(BuildContext context, List<BigImage> images, int index) {
  showDialog<void>(
    context: context,
    barrierColor: Colors.black87,
    builder: (context) => _BigViewer(images: images, start: index),
  );
}

class _BigViewer extends StatefulWidget {
  const _BigViewer({required this.images, required this.start});
  final List<BigImage> images;
  final int start;

  @override
  State<_BigViewer> createState() => _BigViewerState();
}

class _BigViewerState extends State<_BigViewer> {
  late int index = widget.start;

  void go(int step) {
    final n = widget.images.length;
    setState(() => index = (index + step + n) % n);
  }

  @override
  Widget build(BuildContext context) {
    final many = widget.images.length > 1;
    final item = widget.images[index];
    Widget arrow(IconData icon, int step) => IconButton.filled(
          onPressed: () => go(step),
          iconSize: 28,
          style: IconButton.styleFrom(backgroundColor: Colors.white.withValues(alpha: 0.92), foregroundColor: Palette.ink, fixedSize: const Size(52, 52)),
          icon: Icon(icon),
        );
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.arrowLeft): () => go(-1),
        const SingleActivator(LogicalKeyboardKey.arrowRight): () => go(1),
      },
      child: Focus(
        autofocus: true,
        child: Dialog.fullscreen(
          backgroundColor: Colors.transparent,
          child: Stack(children: [
            Positioned.fill(
              child: GestureDetector(
                onTap: () => Navigator.pop(context),
                child: InteractiveViewer(
                  key: ValueKey(index),
                  maxScale: 6,
                  child: Center(child: Padding(padding: EdgeInsets.symmetric(horizontal: many ? 84 : 0), child: Image(image: item.image, fit: BoxFit.contain))),
                ),
              ),
            ),
            if (many) ...[
              Positioned(left: 16, top: 0, bottom: 0, child: Center(child: arrow(Icons.chevron_left_rounded, -1))),
              Positioned(right: 16, top: 0, bottom: 0, child: Center(child: arrow(Icons.chevron_right_rounded, 1))),
              Positioned(
                left: 16,
                top: 20,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(99)),
                  child: Text('${index + 1} / ${widget.images.length}', style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700)),
                ),
              ),
            ],
            Positioned(
              right: 16,
              top: 16,
              child: IconButton.filled(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
            ),
            if (item.caption.isNotEmpty)
              Positioned(
                left: 16,
                right: 80,
                bottom: 16,
                child: Text(item.caption, style: const TextStyle(color: Colors.white, fontSize: 15)),
              ),
          ]),
        ),
      ),
    );
  }
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
    return _Card(
      title: data['edited'] != null ? 'Slide ${data['edited']} updated' : 'Your carousel is ready',
      subtitle: data['cost'] is num ? 'Made by the agents for US\$${(data['cost'] as num).toStringAsFixed(2)} in model calls.' : null,
      trailing: Container(
        width: 36,
        height: 36,
        decoration: const BoxDecoration(color: Palette.successSoft, shape: BoxShape.circle),
        child: const Icon(Icons.check_rounded, color: Palette.success, size: 20),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (data['reel'] is String) ...[
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
          ],
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: Palette.canvas, borderRadius: BorderRadius.circular(10), border: Border.all(color: Palette.border)),
              child: SelectableText(caption, style: const TextStyle(fontSize: 14, height: 1.5)),
            ),
          ),
        ]),
        const SizedBox(height: 14),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(
            icon: const Icon(Icons.download_rounded, size: 18),
            label: const Text('Download everything (ZIP)'),
            onPressed: () => _download(Api.fileUrl('/api/runs/$runId/download')),
          ),
          OutlinedButton.icon(
            icon: const Icon(Icons.copy_rounded, size: 16),
            label: const Text('Copy caption'),
            onPressed: () => Clipboard.setData(ClipboardData(text: caption)),
          ),
          // One reel from the whole carousel; the slides are not animated one by one.
          if (onReel != null)
            OutlinedButton.icon(
              icon: const Icon(Icons.movie_creation_outlined, size: 16),
              label: Text(data['reel'] == null ? 'Make the 30 s reel' : 'Make the reel again'),
              onPressed: onReel,
            ),
        ]),
      ]),
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
    final color = agentColors[event.agent] ?? Palette.muted;
    final data = event.data;
    final image = data is Map ? data['url'] as String? : null;
    final error = event.type == 'error';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(6)),
            child: Text(_agentName(event.agent), style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 12)),
          ),
          const SizedBox(width: 8),
          Text(
            [event.type, if (event.slide != null) 'slide ${event.slide}'].join(' · '),
            style: mono(size: 11, color: Palette.faint),
          ),
        ]),
        const SizedBox(height: 6),
        SelectableText(
          event.text,
          style: event.type == 'tool'
              ? mono(size: 12, color: Palette.ink)
              : TextStyle(fontSize: 13.5, height: 1.45, color: error ? Palette.danger : Palette.ink),
        ),
        if (event.type == 'review' && data is Map && data['checks'] is Map)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(spacing: 6, runSpacing: 6, children: [
              for (final MapEntry(:key, :value) in (data['checks'] as Map).entries)
                Tooltip(
                  message: (value as Map)['note']?.toString() ?? '',
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: value['answer'] == 'no' ? Palette.dangerSoft : Palette.canvas,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: value['answer'] == 'no' ? Palette.danger.withValues(alpha: 0.25) : Palette.border),
                    ),
                    child: Text(
                      '${value['answer'] == 'yes' ? '✓' : value['answer'] == 'no' ? '✗' : '–'} ${key.toString().replaceAll('_', ' ')}',
                      style: TextStyle(fontSize: 12, color: value['answer'] == 'no' ? Palette.danger : Palette.muted),
                    ),
                  ),
                ),
            ]),
          ),
        // Snapshots of each round, the set's contact sheet and assets made with Muse Image.
        if (image != null && event.type != 'slide')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: InkWell(
              onTap: () => showBig(context, NetworkImage(Api.fileUrl(image)), caption: event.text),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.network(Api.fileUrl(image), height: 140),
              ),
            ),
          ),
      ]),
    );
  }
}


// The first screen, like a search: the mascot, the promise and the website; then the style.
class _Start extends StatelessWidget {
  const _Start({required this.state});
  final _StudioPageState state;

  @override
  Widget build(BuildContext context) {
    final s = state;
    final host = (Uri.tryParse(s.website.text.trim().startsWith('http') ? s.website.text.trim() : 'https://${s.website.text.trim()}')?.host ?? '').replaceFirst(RegExp(r'^www\.'), '');
    void next() {
      if (s.website.text.trim().isEmpty) return;
      s.setStartStep(1);
    }


    if (s.startStep == 0) {
      return Scaffold(
        backgroundColor: Palette.ground,
        body: Stack(children: [
          // Behind the promise, what the agents already made, moving.
          const Positioned.fill(child: _HeroWall()),
          const Positioned(top: 18, left: 16, right: 16, child: Center(child: _LiveBanner())),
          Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 40),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: Column(children: [
                Image.asset('assets/mascot.png', width: 150, height: 150),
                const SizedBox(height: 18),
                const Text('Your AI marketing crew for carousels and reels',
                    textAlign: TextAlign.center, style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800, letterSpacing: -0.8, height: 1.15)),
                const SizedBox(height: 28),
                // The search field: the website and the way on.
                Container(
                  padding: const EdgeInsets.fromLTRB(18, 6, 6, 6),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(40), border: Border.all(color: Palette.border, width: 1.5)),
                  child: Row(children: [
                    const Icon(Icons.link_rounded, color: Palette.faint),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: s.website,
                        autofocus: true,
                        onSubmitted: (_) => next(),
                        onChanged: (_) => s.refresh(),
                        style: const TextStyle(fontSize: 17),
                        decoration: const InputDecoration(
                          hintText: 'yourbusiness.com',
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          contentPadding: EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                    FilledButton(
                      onPressed: s.website.text.trim().isEmpty ? null : next,
                      style: FilledButton.styleFrom(minimumSize: const Size(0, 50), padding: const EdgeInsets.symmetric(horizontal: 26), shape: const StadiumBorder()),
                      child: const Row(mainAxisSize: MainAxisSize.min, children: [Text('Next'), SizedBox(width: 6), Icon(Icons.arrow_forward_rounded, size: 18)]),
                    ),
                  ]),
                ),
                const SizedBox(height: 14),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  const Text('Slides in ', style: TextStyle(color: Palette.muted, fontSize: 13.5)),
                  DropdownButton<String>(
                    value: s.language,
                    underline: const SizedBox(),
                    isDense: true,
                    style: const TextStyle(color: Palette.ink, fontSize: 13.5, fontWeight: FontWeight.w700),
                    items: [for (final l in languages) DropdownMenuItem(value: l, child: Text(l))],
                    onChanged: (v) => v == null ? null : s.setLanguage(v),
                  ),
                ]),
              ]),
            ),
          ),
        ),
        ]),
      );
    }

    return Scaffold(
      backgroundColor: Palette.ground,
      body: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1120),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                TextButton.icon(onPressed: () => s.setStartStep(0), icon: const Icon(Icons.arrow_back_rounded, size: 18), label: const Text('Back')),
                const Spacer(),
              ]),
              const SizedBox(height: 18),
              Row(children: [
                Image.asset('assets/mascot.png', width: 56, height: 56),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Pick a style for $host', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -0.4)),
                    const Text('The agents follow it with your logo, colors and photos. Or let them decide from your website.', style: TextStyle(color: Palette.muted)),
                  ]),
                ),
                OutlinedButton(onPressed: () {
                  s.chooseStyle(null);
                  s.start();
                }, child: const Text('Let the agents decide')),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: s.reference == null ? null : s.start,
                  icon: const Icon(Icons.play_arrow_rounded),
                  label: const Text('Start with this style'),
                ),
              ]),
              if (s.error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(s.error!, style: const TextStyle(color: Palette.danger))),
              const SizedBox(height: 20),
              StyleGallery(styles: s.styles, selected: s.reference, uploading: s.uploading, onSelect: s.chooseStyle, onUpload: s.uploadStyles, onDelete: s.deleteStyle),
            ]),
          ),
        ),
      ),
    );
  }
}


// The home's background: slides the agents made, on a tilted wall whose columns drift up
// and down, faded in the middle so the promise and the field read on top.
// The way into the room from the first screen: the run the agents are making now, or the
// newest carousel as a replay. Hidden when there is neither.
class _LiveBanner extends StatefulWidget {
  const _LiveBanner();

  @override
  State<_LiveBanner> createState() => _LiveBannerState();
}

class _LiveBannerState extends State<_LiveBanner> with SingleTickerProviderStateMixin {
  late final pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);
  Timer? poll;
  String? liveId;
  String liveHost = '';
  String? replayId;
  String replayName = '';

  @override
  void initState() {
    super.initState();
    check();
    poll = Timer.periodic(const Duration(seconds: 8), (_) => check());
  }

  @override
  void dispose() {
    poll?.cancel();
    pulse.dispose();
    super.dispose();
  }

  Future<void> check() async {
    try {
      final q = await Api.queue();
      final id = (q['current'] ?? q['running']) as String?;
      final item = ((q['items'] as List?) ?? const []).whereType<Map>().where((i) => i['runId'] == id).firstOrNull;
      final host = (Uri.tryParse('${item?['url'] ?? ''}')?.host ?? '').replaceFirst(RegExp(r'^www\.'), '');
      if (replayId == null && id == null) {
        final feed = await Api.feed();
        if (feed.isNotEmpty && mounted) {
          setState(() {
            replayId = feed.first['id'] as String?;
            replayName = '${feed.first['business'] ?? ''}';
          });
        }
      }
      if (mounted) {
        setState(() {
          liveId = id;
          liveHost = host;
        });
      }
    } catch (_) {
      // The server is down: the first screen still works, only the banner hides.
      if (mounted) setState(() => liveId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = liveId != null;
    final target = liveId ?? replayId;
    if (target == null) return const SizedBox.shrink();
    final color = live ? Palette.danger : Palette.primary;
    final text = live
        ? 'The agents are designing ${liveHost.isEmpty ? 'a carousel' : liveHost} right now'
        : 'See how the agents designed ${replayName.isEmpty ? 'a carousel' : replayName}, step by step';
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 680),
      child: Material(
        color: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999), side: BorderSide(color: color.withValues(alpha: 0.35))),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => openEditView(target),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              FadeTransition(
                opacity: live ? Tween(begin: 0.35, end: 1.0).animate(pulse) : const AlwaysStoppedAnimation(1),
                child: Container(width: 9, height: 9, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
              ),
              const SizedBox(width: 8),
              Text(live ? 'LIVE' : 'REPLAY', style: mono(size: 11, color: color, weight: FontWeight.w800, spacing: 0.6)),
              const SizedBox(width: 10),
              Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Palette.ink))),
              const SizedBox(width: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(999)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(live ? 'Watch it live' : 'Watch a replay', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Colors.white)),
                  const SizedBox(width: 4),
                  const Icon(Icons.arrow_forward_rounded, size: 16, color: Colors.white),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _HeroWall extends StatefulWidget {
  const _HeroWall();

  @override
  State<_HeroWall> createState() => _HeroWallState();
}

class _HeroWallState extends State<_HeroWall> with SingleTickerProviderStateMixin {
  late final drift = AnimationController(vsync: this, duration: const Duration(seconds: 70))..repeat();
  List<String> slides = const [];

  @override
  void initState() {
    super.initState();
    Api.feed().then((feed) {
      final urls = [
        for (final post in feed)
          for (final slide in (post['slides'] as List? ?? const []).take(3))
            if (slide is Map && slide['url'] is String) slide['url'] as String,
      ];
      if (mounted) setState(() => slides = urls.take(60).toList());
    }, onError: (_) {});
  }

  @override
  void dispose() {
    drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (slides.length < 6) return const SizedBox();
    const tileW = 180.0;
    const tileH = 225.0;
    const gap = 14.0;
    return LayoutBuilder(builder: (context, box) {
      final columns = (box.maxWidth * 1.4 / (tileW + gap)).ceil();
      final perColumn = (box.maxHeight * 1.5 / (tileH + gap)).ceil() + 1;
      final cycle = perColumn * (tileH + gap);
      Widget column(int c) {
        final items = [for (var i = 0; i < perColumn; i++) slides[(c * 5 + i) % slides.length]];
        final tiles = [
          for (final url in [...items, ...items])
            Container(
              width: tileW,
              height: tileH,
              margin: const EdgeInsets.only(bottom: gap),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), color: Colors.white),
              clipBehavior: Clip.antiAlias,
              child: Image.network(Api.fileUrl(url), fit: BoxFit.cover, cacheWidth: 360, errorBuilder: (_, _, _) => const SizedBox()),
            ),
        ];
        return AnimatedBuilder(
          animation: drift,
          builder: (context, child) {
            // Even columns rise, odd ones fall; each starts at its own height.
            final t = (drift.value + c * 0.13) % 1;
            final dy = c.isEven ? -t * cycle : -(1 - t) * cycle;
            return Transform.translate(offset: Offset(0, dy), child: child);
          },
          child: Column(mainAxisSize: MainAxisSize.min, children: tiles),
        );
      }

      return Stack(children: [
        Positioned.fill(
          child: ClipRect(
            child: OverflowBox(
              maxWidth: box.maxWidth * 1.4,
              maxHeight: box.maxHeight * 3,
              child: Transform.rotate(
                angle: -0.14,
                child: Opacity(
                  opacity: 0.55,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [for (var c = 0; c < columns; c++) Padding(padding: const EdgeInsets.only(right: gap), child: column(c))],
                  ),
                ),
              ),
            ),
          ),
        ),
        // The middle stays calm: the wall shows at the edges.
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                radius: 0.75,
                colors: [Palette.ground, Palette.ground.withValues(alpha: 0.92), Palette.ground.withValues(alpha: 0.15)],
                stops: const [0, 0.45, 1],
              ),
            ),
          ),
        ),
      ]);
    });
  }
}
