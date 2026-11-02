import 'package:flutter/material.dart';
import 'dart:ui_web' as ui_web;
import 'package:web/web.dart' as web;

import 'api.dart';
import 'main.dart' show showBig;

// Every carousel the agents made, shown as it would look on Facebook and Instagram:
// the feed with each post, the profile grid and the reels, plus the research
// behind each one.
class FeedPage extends StatefulWidget {
  const FeedPage({required this.active, super.key});
  // Reloads each time the tab is opened, so a carousel just made shows up.
  final bool active;

  @override
  State<FeedPage> createState() => _FeedPageState();
}

enum _View { feed, grid, reels }

const _ground = Color(0xFFF0F2F5);
const _muted = Color(0xFF65676B);
const _link = Color(0xFF00376B);

class _FeedPageState extends State<FeedPage> {
  List<Map<String, dynamic>>? posts;
  String? error;
  _View view = _View.feed;

  @override
  void initState() {
    super.initState();
    if (widget.active) load();
  }

  @override
  void didUpdateWidget(FeedPage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) load();
  }

  Future<void> load() async {
    try {
      final list = await Api.feed();
      if (mounted) {
        setState(() {
          posts = list;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = posts;
    final reels = list?.where((p) => p['reel'] != null).toList() ?? const [];
    final shown = reels.isEmpty && view == _View.reels ? _View.feed : view;
    return ColoredBox(
      color: _ground,
      child: Column(children: [
        Container(
          color: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(children: [
            Text(
              list == null ? 'Feed' : '${list.length} carousels${reels.isEmpty ? '' : ' · ${reels.length} reels'}',
              style: const TextStyle(fontWeight: FontWeight.w600, color: _muted),
            ),
            const Spacer(),
            SegmentedButton<_View>(
              showSelectedIcon: false,
              // The server sends no reels while they are off.
              segments: [
                const ButtonSegment(value: _View.feed, icon: Icon(Icons.view_agenda_outlined, size: 18), label: Text('Feed', softWrap: false)),
                const ButtonSegment(value: _View.grid, icon: Icon(Icons.grid_on, size: 18), label: Text('Grid', softWrap: false)),
                if (reels.isNotEmpty)
                  const ButtonSegment(value: _View.reels, icon: Icon(Icons.movie_outlined, size: 18), label: Text('Reels', softWrap: false)),
              ],
              selected: {shown},
              onSelectionChanged: (v) => setState(() => view = v.first),
            ),
            const SizedBox(width: 8),
            TextButton.icon(onPressed: () => showTaste(context), icon: const Icon(Icons.insights, size: 18), label: const Text('Your taste')),
            IconButton(tooltip: 'Refresh', onPressed: load, icon: const Icon(Icons.refresh)),
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: error != null
              ? Center(child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)))
              : list == null
                  ? const Center(child: CircularProgressIndicator())
                  : list.isEmpty
                      ? const Center(child: Text('No carousels yet: make one in Create.'))
                      : switch (shown) {
                          _View.feed => ListView.separated(
                              padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
                              itemCount: list.length,
                              separatorBuilder: (_, _) => const SizedBox(height: 16),
                              itemBuilder: (_, i) => Center(
                                child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 520), child: PostCard(post: list[i])),
                              ),
                            ),
                          _View.grid => _Grid(posts: list),
                          _View.reels => _Reels(posts: reels),
                        },
        ),
      ]),
    );
  }
}

// One post as Instagram shows it: the business with its logo, the carousel (or its
// reel), the actions, the caption with its hashtags and what the agents did.
class PostCard extends StatefulWidget {
  const PostCard({required this.post, super.key});
  final Map<String, dynamic> post;

  @override
  State<PostCard> createState() => _PostCardState();
}

class _PostCardState extends State<PostCard> {
  final pages = PageController();
  int page = 0;
  bool reel = false;
  bool more = false;
  late Map<String, int> votes = ((widget.post['votes'] as Map?) ?? {}).cast<String, int>();
  late int? stars = widget.post['stars'] as int?;
  bool styled = false;

  // A 5-star carousel can become a style in the gallery Create starts from.
  Future<void> addToGallery() async {
    try {
      await Api.referenceFromRun(widget.post['id'] as String);
      if (!mounted) return;
      setState(() => styled = true);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Added to the style gallery in Create.')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  // Tapping the same thumb again takes the vote back. A dislike asks what's wrong: the
  // critic learns from those words what it let through.
  Future<void> vote(String target, int value) async {
    final next = votes[target] == value ? 0 : value;
    String? note;
    if (next == -1) {
      note = await _askWhatsWrong(context, target);
      if (note == null) return;
    }
    await _save(target, next, note: note);
  }

  // Tapping the same star again takes the rating back. Under 4 asks what's missing.
  Future<void> rate(int value) async {
    if (stars == value) return _save('carousel', 0);
    String? note;
    if (value <= 3) {
      note = await _askWhatsWrong(context, 'carousel', stars: value);
      if (note == null) return;
    }
    await _save('carousel', 0, stars: value, note: note);
  }

  Future<void> _save(String target, int value, {int? stars, String? note}) async {
    try {
      final saved = await Api.vote(widget.post['id'] as String, target, value, stars: stars, note: note);
      if (mounted) {
        setState(() {
          votes = saved.votes;
          this.stars = saved.stars;
        });
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  void dispose() {
    pages.dispose();
    super.dispose();
  }

  void go(int to) => pages.animateToPage(to, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);

  @override
  Widget build(BuildContext context) {
    final p = widget.post;
    final slides = (p['slides'] as List).cast<Map<String, dynamic>>();
    final research = p['research'] as Map<String, dynamic>;
    final reelUrl = p['reel'] as String?;
    final caption = p['caption'] as String? ?? '';
    final hashtags = hashtagsOf(p['hashtags']);
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
          child: Row(children: [
            BusinessAvatar(post: p),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p['business'] as String, style: const TextStyle(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                Row(children: [
                  Flexible(
                    child: Text(
                      '${_host(p['url'] as String?)} · ${_ago(p['createdAt'] as String)}',
                      style: const TextStyle(color: _muted, fontSize: 12),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(Icons.public, size: 12, color: _muted),
                ]),
              ]),
            ),
            TextButton.icon(
              onPressed: () => showResearch(context, p),
              icon: const Icon(Icons.travel_explore, size: 18),
              label: const Text('Research'),
            ),
          ]),
        ),
        if (reel && reelUrl != null)
          ColoredBox(
            color: Colors.black,
            child: Center(
              child: SizedBox(
                width: 360,
                child: AspectRatio(aspectRatio: 9 / 16, child: WebVideo(url: Api.fileUrl(reelUrl), controls: true, key: ValueKey('post-$reelUrl'))),
              ),
            ),
          )
        else
          AspectRatio(
            aspectRatio: 4 / 5,
            child: Stack(children: [
              PageView.builder(
                controller: pages,
                itemCount: slides.length,
                onPageChanged: (i) => setState(() => page = i),
                itemBuilder: (_, i) => GestureDetector(
                  onTap: () => showBig(context, NetworkImage(Api.fileUrl(slides[i]['url'] as String)), caption: '${p['business']} · ${i + 1}/${slides.length}'),
                  child: Image.network(Api.fileUrl(slides[i]['url'] as String), fit: BoxFit.cover),
                ),
              ),
              Positioned(
                right: 12,
                top: 12,
                child: _Pill('${page + 1}/${slides.length}'),
              ),
              if (page > 0) Positioned(left: 8, top: 0, bottom: 0, child: Center(child: _Arrow(Icons.chevron_left, () => go(page - 1)))),
              if (page < slides.length - 1)
                Positioned(right: 8, top: 0, bottom: 0, child: Center(child: _Arrow(Icons.chevron_right, () => go(page + 1)))),
            ]),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
          child: Row(children: [
            _Thumbs(
              label: reel ? 'Reel' : 'Slide ${page + 1}',
              value: votes[reel ? 'reel' : 'slide:${page + 1}'],
              onVote: (v) => vote(reel ? 'reel' : 'slide:${page + 1}', v),
            ),
            const Spacer(),
            if (!reel)
              Row(children: [
                for (var i = 0; i < slides.length; i++)
                  Container(
                    width: 6,
                    height: 6,
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    decoration: BoxDecoration(shape: BoxShape.circle, color: i == page ? const Color(0xFF0095F6) : const Color(0xFFC7C7C7)),
                  ),
              ]),
            const Spacer(),
            if (reelUrl != null)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: SegmentedButton<bool>(
                  showSelectedIcon: false,
                  style: const ButtonStyle(visualDensity: VisualDensity.compact),
                  segments: const [
                    ButtonSegment(value: false, icon: Icon(Icons.collections_outlined, size: 16)),
                    ButtonSegment(value: true, icon: Icon(Icons.movie_outlined, size: 16)),
                  ],
                  selected: {reel},
                  onSelectionChanged: (v) => setState(() => reel = v.first),
                ),
              ),
            IconButton(
              tooltip: stars == 5 ? 'Add to the style gallery' : 'Rate it 5 ★ to add it to the style gallery',
              onPressed: stars == 5 && !styled ? addToGallery : null,
              icon: Icon(styled ? Icons.bookmark : Icons.bookmark_border),
            ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
          child: GestureDetector(
            onTap: () => setState(() => more = !more),
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: '${p['business']} ', style: const TextStyle(fontWeight: FontWeight.w700)),
                TextSpan(text: caption),
                if (hashtags.isNotEmpty) TextSpan(text: '\n${hashtags.join(' ')}', style: const TextStyle(color: _link)),
              ]),
              maxLines: more ? null : 3,
              overflow: more ? null : TextOverflow.ellipsis,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 6, 6, 8),
          child: Row(children: [
            Expanded(
              child: Text(
                [
                  'Made by the agents',
                  '${research['approved']}/${slides.length} approved',
                  if (research['setScore'] != null) 'set ${_score(research['setScore'])}/10',
                  if (p['cost'] is num) 'US\$${(p['cost'] as num).toStringAsFixed(2)}',
                ].join(' · '),
                style: const TextStyle(color: _muted, fontSize: 12),
              ),
            ),
            _Stars(value: stars, onRate: rate),
            TextButton(
              onPressed: () => web.window.location.href = '/?run=${p['id']}',
              child: const Text("See the agents' work"),
            ),
          ]),
        ),
      ]),
    );
  }
}

// The whole carousel from 1 to 5: 4-5 count as a like, 1-2 as a dislike.
class _Stars extends StatelessWidget {
  const _Stars({required this.value, required this.onRate});
  final int? value;
  final ValueChanged<int> onRate;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 1; i <= 5; i++)
          InkResponse(
            onTap: () => onRate(i),
            radius: 16,
            child: Tooltip(
              message: '$i of 5',
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1, vertical: 6),
                child: Icon(
                  (value ?? 0) >= i ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: 22,
                  color: (value ?? 0) >= i ? const Color(0xFFF5A524) : const Color(0xFFC7C7C7),
                ),
              ),
            ),
          ),
      ]);
}

// Null when the owner cancels the dislike; an empty note still counts as a dislike.
Future<String?> _askWhatsWrong(BuildContext context, String target, {int? stars}) {
  final text = TextEditingController();
  final what = target == 'carousel' ? 'this carousel' : target == 'reel' ? 'this reel' : target.replaceFirst('slide:', 'slide ');
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(stars == null ? "What's wrong with $what?" : '$stars ★ · What would make it a 5?'),
      content: SizedBox(
        width: 460,
        child: TextField(
          controller: text,
          autofocus: true,
          minLines: 2,
          maxLines: 5,
          decoration: const InputDecoration(
            hintText: 'e.g. the headline is too small to read on a phone; the product is cut',
            helperText: 'Optional. The critic reads it before approving the next ones.',
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, text.text), child: Text(stars == null ? 'Dislike' : 'Rate')),
      ],
    ),
  ).whenComplete(text.dispose);
}

// What the votes taught the agents: how often the critic agrees with the owner, the
// likes per batch and, per design choice, the share of likes (Beta mean, so one vote
// doesn't read as 100 %) and the votes behind it.
Future<void> showTaste(BuildContext context) async {
  final List<Map<String, dynamic>> stats;
  final Map<String, dynamic> calibration;
  try {
    (stats, calibration) = await (Api.taste(), Api.calibration()).wait;
  } catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    return;
  }
  if (!context.mounted) return;
  final byKey = <String, List<Map<String, dynamic>>>{};
  for (final s in stats) {
    byKey.putIfAbsent(s['key'] as String, () => []).add(s);
  }
  await showDialog<void>(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('Your taste'),
      content: SizedBox(
        width: 520,
        child: stats.isEmpty
            ? const Text('Vote on carousels, slides and reels in the feed: the agents learn what you like from your votes.')
            : ListView(shrinkWrap: true, children: [
                _Calibration(report: calibration),
                for (final entry in byKey.entries) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 12, bottom: 4),
                    child: Text(entry.key.toUpperCase(), style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _muted, letterSpacing: 0.6)),
                  ),
                  for (final s in entry.value) _TasteRow(stat: s),
                ],
              ]),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close'))],
    ),
  );
}

// The critic against the owner: its approval should mean the owner's like. "Too easy"
// lists what it approved and the owner disliked, with the owner's words.
class _Calibration extends StatelessWidget {
  const _Calibration({required this.report});
  final Map<String, dynamic> report;

  @override
  Widget build(BuildContext context) {
    final rate = report['rate'] as num?;
    final tooEasy = (report['tooEasy'] as List).cast<Map<String, dynamic>>();
    final tooHard = (report['tooHard'] as List).length;
    final batches = (report['batches'] as List).cast<Map<String, dynamic>>();
    const label = TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _muted, letterSpacing: 0.6);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('CRITIC VS YOU', style: label),
      const SizedBox(height: 4),
      Text(
        rate == null ? 'No votes on finished work yet.' : 'The critic agrees with you on ${(rate * 100).round()} % of ${report['judged']} votes.',
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
      if (rate != null)
        Text('Approved by the critic, disliked by you: ${tooEasy.length} · rejected by the critic, liked by you: $tooHard',
            style: const TextStyle(fontSize: 12, color: _muted)),
      for (final v in tooEasy.where((v) => (v['note'] as String?)?.isNotEmpty ?? false).take(5))
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('${v['business'] ?? '?'} · ${(v['target'] as String).replaceFirst('slide:', 'slide ')}: “${v['note']}”',
              style: const TextStyle(fontSize: 12)),
        ),
      if (batches.isNotEmpty) ...[
        const Padding(padding: EdgeInsets.only(top: 14, bottom: 4), child: Text('CAROUSELS YOU LIKED, PER BATCH', style: label)),
        for (final b in batches)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(children: [
              Expanded(child: Text(b['batch'] as String, overflow: TextOverflow.ellipsis)),
              Text('${(((b['liked'] as num) / (b['voted'] as num)) * 100).round()} %  (${b['liked']}/${b['voted']})',
                  style: const TextStyle(fontWeight: FontWeight.w600)),
            ]),
          ),
      ],
      const Divider(height: 24),
    ]);
  }
}

class _TasteRow extends StatelessWidget {
  const _TasteRow({required this.stat});
  final Map<String, dynamic> stat;

  @override
  Widget build(BuildContext context) {
    final mean = (stat['mean'] as num).toDouble();
    final color = mean >= 0.6 ? const Color(0xFF0095F6) : mean <= 0.4 ? const Color(0xFFED4956) : const Color(0xFFC7C7C7);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        SizedBox(width: 170, child: Text(stat['value'] as String, overflow: TextOverflow.ellipsis)),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(value: mean, minHeight: 8, color: color, backgroundColor: const Color(0xFFEFEFEF)),
          ),
        ),
        SizedBox(
          width: 84,
          child: Text('${stat['up']} 👍 ${stat['down']} 👎', textAlign: TextAlign.right, style: const TextStyle(fontSize: 12, color: _muted)),
        ),
      ]),
    );
  }
}

// The owner's like or dislike: the votes the agents learn the owner's taste from.
class _Thumbs extends StatelessWidget {
  const _Thumbs({required this.label, required this.value, required this.onVote});
  final String label;
  final int? value;
  final ValueChanged<int> onVote;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.only(left: 8), child: Text(label, style: const TextStyle(color: _muted, fontSize: 12))),
        IconButton(
          tooltip: 'I like it',
          visualDensity: VisualDensity.compact,
          onPressed: () => onVote(1),
          icon: Icon(value == 1 ? Icons.thumb_up : Icons.thumb_up_outlined, size: 20, color: value == 1 ? const Color(0xFF0095F6) : null),
        ),
        IconButton(
          tooltip: "I don't like it",
          visualDensity: VisualDensity.compact,
          onPressed: () => onVote(-1),
          icon: Icon(value == -1 ? Icons.thumb_down : Icons.thumb_down_outlined, size: 20, color: value == -1 ? const Color(0xFFED4956) : null),
        ),
      ]);
}

// The business logo in the round avatar, on its own background color.
class BusinessAvatar extends StatelessWidget {
  const BusinessAvatar({required this.post, this.size = 40, super.key});
  final Map<String, dynamic> post;
  final double size;

  @override
  Widget build(BuildContext context) {
    final logo = post['logo'] as String?;
    final name = post['business'] as String? ?? '?';
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size * 0.14),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: _hex(post['logoGround'] as String?) ?? Colors.white,
        border: Border.all(color: const Color(0xFFDBDBDB)),
      ),
      clipBehavior: Clip.antiAlias,
      child: logo != null
          ? Image.network(Api.fileUrl(logo), fit: BoxFit.contain)
          : Center(child: Text(name.characters.first.toUpperCase(), style: TextStyle(fontWeight: FontWeight.w700, fontSize: size * 0.4))),
    );
  }
}

// What the agents learned before designing: the site as they read it, the
// strategy, the brand system taken from it and how the result was judged.
void showResearch(BuildContext context, Map<String, dynamic> post) {
  final r = post['research'] as Map<String, dynamic>;
  final screens = (r['screens'] as List).cast<String>();
  final colors = (r['colors'] as List).cast<String>();
  final fonts = (r['fonts'] as List).cast<String>();
  final siteFonts = (r['siteFonts'] as List).cast<String>();
  final assets = (r['assets'] as Map).cast<String, dynamic>();
  final text = Theme.of(context).textTheme;
  Widget section(String title, List<Widget> children) => Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: text.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          ...children,
        ]),
      );
  showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      insetPadding: const EdgeInsets.all(16),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(20), children: [
          Row(children: [
            BusinessAvatar(post: post, size: 48),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(post['business'] as String, style: text.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                Text('How the agents researched it', style: text.bodyMedium?.copyWith(color: _muted)),
              ]),
            ),
            IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
          ]),
          section('The website', [
            if (post['url'] != null)
              InkWell(
                onTap: () => web.window.open(post['url'] as String, '_blank'),
                child: Text(post['url'] as String, style: const TextStyle(color: _link, decoration: TextDecoration.underline)),
              ),
            if (r['siteTitle'] != null) Text(r['siteTitle'] as String, style: const TextStyle(color: _muted)),
            if (screens.isNotEmpty) ...[
              const SizedBox(height: 8),
              SizedBox(
                height: 150,
                child: ListView(scrollDirection: Axis.horizontal, children: [
                  for (final s in screens)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: InkWell(
                        onTap: () => showBig(context, NetworkImage(Api.fileUrl(s)), caption: 'What the analyst saw'),
                        child: Container(
                          decoration: BoxDecoration(border: Border.all(color: const Color(0xFFDBDBDB)), borderRadius: BorderRadius.circular(6)),
                          clipBehavior: Clip.antiAlias,
                          child: Image.network(Api.fileUrl(s), height: 150, fit: BoxFit.cover, alignment: Alignment.topCenter),
                        ),
                      ),
                    ),
                ]),
              ),
            ],
          ]),
          section('What the analyst found', [
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final MapEntry(:key, :value) in assets.entries) Chip(visualDensity: VisualDensity.compact, label: Text('$value $key')),
              Chip(visualDensity: VisualDensity.compact, label: Text('${r['photos']} photos usable')),
              if ((r['ownerPhotos'] as num? ?? 0) > 0) Chip(visualDensity: VisualDensity.compact, label: Text("${r['ownerPhotos']} from the owner")),
            ]),
          ]),
          if (r['concept'] != null)
            section('Strategy', [
              Text(
                [r['businessType'], if (r['format'] != null) '${r['format']} carousel'].whereType<String>().join(' · '),
                style: const TextStyle(color: _muted),
              ),
              const SizedBox(height: 4),
              Text(r['concept'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (r['why'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(r['why'] as String)),
            ]),
          if (colors.isNotEmpty || fonts.isNotEmpty || r['design'] != null)
            section('The brand, read from the site', [
              Row(children: [
                for (final c in colors)
                  Tooltip(
                    message: c,
                    child: Container(
                      width: 36,
                      height: 36,
                      margin: const EdgeInsets.only(right: 6),
                      decoration: BoxDecoration(color: _hex(c), borderRadius: BorderRadius.circular(6), border: Border.all(color: const Color(0xFFDBDBDB))),
                    ),
                  ),
                const SizedBox(width: 8),
                if (fonts.isNotEmpty) Expanded(child: Text('Type: ${fonts.toSet().join(' + ')}')),
              ]),
              if (siteFonts.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('Fonts on the site: ${siteFonts.take(4).join(', ')}', style: const TextStyle(color: _muted, fontSize: 12)),
                ),
              if (r['design'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(r['design'] as String)),
            ]),
          section('Quality', [
            Text(
              [
                '${r['approved']}/${(post['slides'] as List).length} slides approved by the critic',
                if (r['setScore'] != null) 'the whole set ${_score(r['setScore'])}/10',
                if (post['cost'] is num) 'US\$${(post['cost'] as num).toStringAsFixed(2)} in models',
              ].join(' · '),
            ),
          ]),
        ]),
      ),
    ),
  );
}

// The profile grid: every carousel by its cover; tap opens the post.
class _Grid extends StatelessWidget {
  const _Grid({required this.posts});
  final List<Map<String, dynamic>> posts;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 940),
        child: GridView.builder(
          padding: const EdgeInsets.all(12),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 300, childAspectRatio: 4 / 5, crossAxisSpacing: 4, mainAxisSpacing: 4),
          itemCount: posts.length,
          itemBuilder: (_, i) {
            final p = posts[i];
            final cover = ((p['slides'] as List).first as Map)['url'] as String;
            return InkWell(
              onTap: () => _openPost(context, p),
              child: Stack(fit: StackFit.expand, children: [
                Image.network(Api.fileUrl(cover), fit: BoxFit.cover),
                Positioned(
                  right: 8,
                  top: 8,
                  child: Row(children: [
                    if (p['reel'] != null) const Icon(Icons.movie, color: Colors.white, size: 20, shadows: [Shadow(blurRadius: 4)]),
                    const SizedBox(width: 4),
                    const Icon(Icons.collections, color: Colors.white, size: 20, shadows: [Shadow(blurRadius: 4)]),
                  ]),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(8, 24, 8, 8),
                    decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Colors.black54])),
                    child: Row(children: [
                      BusinessAvatar(post: p, size: 26),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(p['business'] as String, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                      ),
                    ]),
                  ),
                ),
              ]),
            );
          },
        ),
      ),
    );
  }
}

// The reels side by side, playing muted; tap opens one with sound.
class _Reels extends StatelessWidget {
  const _Reels({required this.posts});
  final List<Map<String, dynamic>> posts;

  @override
  Widget build(BuildContext context) {
    if (posts.isEmpty) return const Center(child: Text('No reels yet: make one from a finished carousel.'));
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Center(
        child: Wrap(spacing: 12, runSpacing: 12, children: [
          for (final p in posts)
            SizedBox(
              width: 230,
              child: AspectRatio(
                aspectRatio: 9 / 16,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Stack(fit: StackFit.expand, children: [
                    WebVideo(url: Api.fileUrl(p['reel'] as String), key: ValueKey('reel-${p['reel']}')),
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: Container(
                        padding: const EdgeInsets.fromLTRB(10, 30, 10, 10),
                        decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Colors.black54])),
                        child: Row(children: [
                          BusinessAvatar(post: p, size: 28),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(p['business'] as String, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                          ),
                        ]),
                      ),
                    ),
                    // The video is a platform view: this layer on top takes the tap.
                    Positioned.fill(
                      child: Material(
                        type: MaterialType.transparency,
                        child: InkWell(onTap: () => _openReel(context, p)),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

void _openPost(BuildContext context, Map<String, dynamic> post) {
  showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      insetPadding: const EdgeInsets.all(16),
      backgroundColor: Colors.transparent,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: SingleChildScrollView(child: PostCard(post: post)),
      ),
    ),
  );
}

void _openReel(BuildContext context, Map<String, dynamic> post) {
  showDialog<void>(
    context: context,
    barrierColor: Colors.black87,
    builder: (context) => Dialog(
      backgroundColor: Colors.black,
      insetPadding: const EdgeInsets.all(16),
      child: Stack(children: [
        SizedBox(
          width: 400,
          child: AspectRatio(aspectRatio: 9 / 16, child: WebVideo(url: Api.fileUrl(post['reel'] as String), controls: true, key: ValueKey('open-${post['reel']}'))),
        ),
        Positioned(right: 8, top: 8, child: IconButton.filled(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close))),
      ]),
    ),
  );
}

// A video in a loop; with controls it starts with sound, like opening a reel.
class WebVideo extends StatelessWidget {
  const WebVideo({required this.url, this.controls = false, super.key});
  final String url;
  final bool controls;

  @override
  Widget build(BuildContext context) {
    final viewType = 'web-video-$controls-$url';
    if (_registered.add(viewType)) {
      ui_web.platformViewRegistry.registerViewFactory(viewType, (int _) {
        return web.HTMLVideoElement()
          ..src = url
          ..autoplay = true
          ..loop = true
          ..muted = !controls
          ..controls = controls
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

class _Pill extends StatelessWidget {
  const _Pill(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(99)),
        child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 12)),
      );
}

class _Arrow extends StatelessWidget {
  const _Arrow(this.icon, this.onTap);
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.white.withValues(alpha: 0.85),
        shape: const CircleBorder(),
        child: InkWell(customBorder: const CircleBorder(), onTap: onTap, child: Padding(padding: const EdgeInsets.all(4), child: Icon(icon, size: 22))),
      );
}

Color? _hex(String? hex) {
  final value = int.tryParse((hex ?? '').replaceFirst('#', ''), radix: 16);
  return value == null ? null : Color(0xFF000000 | value);
}

String _host(String? url) => url == null ? 'Sponsored' : (Uri.tryParse(url)?.host ?? url).replaceFirst('www.', '');

String _score(Object? n) => n is num && n == n.roundToDouble() ? n.toInt().toString() : '$n';

String _ago(String iso) {
  final at = DateTime.tryParse(iso);
  if (at == null) return '';
  final d = DateTime.now().difference(at);
  if (d.inMinutes < 1) return 'now';
  if (d.inMinutes < 60) return '${d.inMinutes} min';
  if (d.inHours < 24) return '${d.inHours} h';
  if (d.inDays < 7) return '${d.inDays} d';
  return '${at.day}/${at.month}/${at.year}';
}
