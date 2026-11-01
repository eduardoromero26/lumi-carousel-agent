import 'package:flutter/material.dart';

import 'api.dart';
import 'main.dart' show Palette;

// What the agents learned, as a library: shelves (design, critic, fixes, quality,
// references) of cards, each with the evidence behind it. A lesson can be learned
// wrong, so the owner votes it: a dislike turns it off and its note tells the agent why.
class LearnedPage extends StatefulWidget {
  const LearnedPage({required this.active, super.key});
  // Reloads each time the tab is opened, so the latest votes show up.
  final bool active;

  @override
  State<LearnedPage> createState() => _LearnedPageState();
}

class _LearnedPageState extends State<LearnedPage> {
  final search = TextEditingController();
  List<Map<String, dynamic>>? shelves;
  String? error;
  String? shelf;

  @override
  void initState() {
    super.initState();
    if (widget.active) load();
  }

  @override
  void didUpdateWidget(LearnedPage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) load();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final list = await Api.learned();
      if (mounted) {
        setState(() {
          shelves = list;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  // Tapping the same thumb again takes the vote back.
  Future<void> vote(Map<String, dynamic> card, int value) async {
    final next = card['vote'] == value ? 0 : value;
    String? note;
    if (next == -1) {
      note = await _askWhyWrong(context, card['title'] as String);
      if (note == null) return;
    }
    try {
      await Api.voteLearned(card['id'] as String, next, note: note);
      await load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  bool _matches(Map<String, dynamic> card, String query) =>
      query.isEmpty || [card['title'], card['text'], card['evidence'], card['feedback']].any((s) => (s as String? ?? '').toLowerCase().contains(query));

  @override
  Widget build(BuildContext context) {
    final list = shelves;
    final query = search.text.trim().toLowerCase();
    return ColoredBox(
      color: Palette.canvas,
      child: error != null
          ? Center(child: Text(error!, style: const TextStyle(color: Palette.danger)))
          : list == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 40), children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 1100),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          const Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text('What the agents learned', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.3)),
                              SizedBox(height: 2),
                              Text('Vote each lesson: 👍 keeps it, 👎 turns it off and tells the agent why.', style: TextStyle(color: Palette.muted)),
                            ]),
                          ),
                          IconButton(tooltip: 'Refresh', onPressed: load, icon: const Icon(Icons.refresh)),
                        ]),
                        const SizedBox(height: 16),
                        TextField(
                          controller: search,
                          onChanged: (_) => setState(() {}),
                          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search the library'),
                        ),
                        const SizedBox(height: 12),
                        Wrap(spacing: 8, runSpacing: 8, children: [
                          ChoiceChip(label: const Text('All'), selected: shelf == null, onSelected: (_) => setState(() => shelf = null)),
                          for (final s in list)
                            ChoiceChip(
                              label: Text('${s['title']} ${(s['cards'] as List).length}'),
                              selected: shelf == s['id'],
                              onSelected: (_) => setState(() => shelf = shelf == s['id'] ? null : s['id'] as String),
                            ),
                        ]),
                        for (final s in list.where((s) => shelf == null || s['id'] == shelf))
                          _ShelfView(
                            shelf: s,
                            cards: (s['cards'] as List).cast<Map<String, dynamic>>().where((c) => _matches(c, query)).toList(),
                            searching: query.isNotEmpty,
                            onVote: vote,
                          ),
                      ]),
                    ),
                  ),
                ]),
    );
  }
}

class _ShelfView extends StatelessWidget {
  const _ShelfView({required this.shelf, required this.cards, required this.searching, required this.onVote});
  final Map<String, dynamic> shelf;
  final List<Map<String, dynamic>> cards;
  final bool searching;
  final void Function(Map<String, dynamic> card, int value) onVote;

  @override
  Widget build(BuildContext context) {
    if (searching && cards.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 28),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text((shelf['title'] as String).toUpperCase(), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: Palette.primary, letterSpacing: 0.8)),
        const SizedBox(height: 4),
        Text(shelf['about'] as String, style: const TextStyle(color: Palette.muted)),
        const SizedBox(height: 12),
        if (cards.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.border)),
            child: const Text('Nothing here yet.', style: TextStyle(color: Palette.faint)),
          )
        else
          LayoutBuilder(builder: (context, box) {
            final columns = (box.maxWidth / 340).floor().clamp(1, 3);
            final width = (box.maxWidth - 12 * (columns - 1)) / columns;
            return Wrap(spacing: 12, runSpacing: 12, children: [
              for (final c in cards) SizedBox(width: width, child: _LessonCard(card: c, onVote: (v) => onVote(c, v))),
            ]);
          }),
      ]),
    );
  }
}

class _LessonCard extends StatelessWidget {
  const _LessonCard({required this.card, required this.onVote});
  final Map<String, dynamic> card;
  final ValueChanged<int> onVote;

  @override
  Widget build(BuildContext context) {
    final vote = card['vote'] as int?;
    final off = vote == -1;
    final feedback = card['feedback'] as String?;
    final tone = switch (card['tone']) { 'good' => Palette.primary, 'bad' => Palette.danger, _ => Palette.faint };
    final evidence = card['evidence'] as String? ?? '';
    return Opacity(
      opacity: off ? 0.75 : 1,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 6, 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: off ? Palette.danger.withValues(alpha: 0.4) : Palette.border),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: const EdgeInsets.only(top: 6, right: 8),
              child: Container(width: 8, height: 8, decoration: BoxDecoration(color: tone, shape: BoxShape.circle)),
            ),
            Expanded(
              child: Text(card['title'] as String,
                  style: TextStyle(fontWeight: FontWeight.w700, decoration: off ? TextDecoration.lineThrough : null)),
            ),
          ]),
          const SizedBox(height: 6),
          if (card['image'] != null)
            Container(
              height: 160,
              margin: const EdgeInsets.only(right: 8, bottom: 8),
              decoration: BoxDecoration(color: Palette.border.withValues(alpha: 0.35), borderRadius: BorderRadius.circular(8)),
              clipBehavior: Clip.antiAlias,
              child: Center(child: Image.network(Api.fileUrl(card['image'] as String), fit: BoxFit.contain)),
            ),
          Padding(padding: const EdgeInsets.only(right: 8), child: SelectableText(card['text'] as String, style: const TextStyle(fontSize: 13, height: 1.4))),
          if (off)
            Container(
              margin: const EdgeInsets.only(top: 8, right: 8),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(color: Palette.dangerSoft, borderRadius: BorderRadius.circular(8)),
              child: Text(
                feedback == null || feedback.isEmpty ? 'Turned off: the agents no longer use it.' : 'Turned off. You said: “$feedback”',
                style: const TextStyle(fontSize: 12, color: Palette.danger),
              ),
            ),
          Row(children: [
            Expanded(child: Text(evidence, style: const TextStyle(fontSize: 12, color: Palette.faint))),
            if (card['id'] != null) ...[
              IconButton(
                tooltip: 'Right: keep it',
                visualDensity: VisualDensity.compact,
                onPressed: () => onVote(1),
                icon: Icon(vote == 1 ? Icons.thumb_up : Icons.thumb_up_outlined, size: 18, color: vote == 1 ? Palette.primary : Palette.faint),
              ),
              IconButton(
                tooltip: 'Learned wrong: turn it off',
                visualDensity: VisualDensity.compact,
                onPressed: () => onVote(-1),
                icon: Icon(off ? Icons.thumb_down : Icons.thumb_down_outlined, size: 18, color: off ? Palette.danger : Palette.faint),
              ),
            ] else
              const SizedBox(height: 40),
          ]),
        ]),
      ),
    );
  }
}

// Null when the owner cancels; an empty note still turns the lesson off.
Future<String?> _askWhyWrong(BuildContext context, String title) {
  final text = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('What did the agents learn wrong?'),
      content: SizedBox(
        width: 460,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          TextField(
            controller: text,
            autofocus: true,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(
              hintText: 'e.g. bold type was fine; what I disliked were the cut photos',
              helperText: 'Optional. The lesson is turned off and the agent reads your words.',
            ),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, text.text), child: const Text('Turn it off')),
      ],
    ),
  ).whenComplete(text.dispose);
}
