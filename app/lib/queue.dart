import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

import 'api.dart';
import 'main.dart' show Palette, languages;

// Many websites, one carousel after another, grouped in batches. A batch's numbers
// (set score, slides approved on the first pass, checks that failed, cost) say if a
// change to the agents helped: run the same websites again under a new batch name.
class QueuePage extends StatefulWidget {
  const QueuePage({required this.active, super.key});
  final bool active;

  @override
  State<QueuePage> createState() => _QueuePageState();
}

class _QueuePageState extends State<QueuePage> {
  final urls = TextEditingController();
  final batch = TextEditingController();
  String language = web.window.navigator.language.startsWith('es') ? 'Español' : 'English';
  Map<String, dynamic>? state;
  List<Map<String, dynamic>> lists = const [];
  String? error;
  String? openBatch;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _poll();
    Api.lists().then((l) {
      if (mounted) setState(() => lists = l);
    }, onError: (Object e) {});
  }

  @override
  void didUpdateWidget(QueuePage old) {
    super.didUpdateWidget(old);
    if (widget.active != old.active) _poll();
  }

  // Refreshes every few seconds while the tab is open.
  void _poll() {
    timer?.cancel();
    if (!widget.active) return;
    load();
    timer = Timer.periodic(const Duration(seconds: 5), (_) => load());
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load() => _call(Api.queue);

  Future<void> _call(Future<Map<String, dynamic>> Function() call) async {
    try {
      final s = await call();
      if (mounted) {
        setState(() {
          state = s;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = '$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> add() async {
    final list = urls.text.split(RegExp(r'[\s,]+')).where((u) => u.trim().isNotEmpty).toList();
    if (list.isEmpty) return;
    await _call(() => Api.enqueue(list, language, batch.text.trim()));
    if (error == null) urls.clear();
  }

  // The same websites again, under a new batch name, to compare after a change.
  void again(String name) {
    final items = _items.where((i) => i['batch'] == name).map((i) => i['url'] as String).toSet();
    setState(() {
      urls.text = items.join('\n');
      batch.text = '$name · again';
    });
  }

  Future<void> copyReport(String name) async {
    try {
      await Clipboard.setData(ClipboardData(text: await Api.batchReport(name)));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Report of "$name" copied')));
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  Future<void> copyFailures() async {
    try {
      await Clipboard.setData(ClipboardData(text: await Api.failures()));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failure history copied')));
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  List<Map<String, dynamic>> get _items => ((state?['items'] as List?) ?? const []).cast<Map<String, dynamic>>();

  @override
  Widget build(BuildContext context) {
    final s = state;
    final paused = s?['paused'] == true;
    final batches = ((s?['batches'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final waiting = _items.where((i) => i['status'] == 'waiting').length;
    return ColoredBox(
      color: Palette.canvas,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1100),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Card(
                color: Colors.white,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text('Add websites', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 4),
                    const Text('One per line. Each one becomes a carousel, one after another.', style: TextStyle(color: Palette.muted)),
                    const SizedBox(height: 12),
                    TextField(controller: urls, minLines: 3, maxLines: 8, decoration: const InputDecoration(hintText: 'tienda.mx\nclinica.com.mx')),
                    const SizedBox(height: 12),
                    Wrap(spacing: 12, runSpacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      SizedBox(
                        width: 280,
                        child: TextField(controller: batch, decoration: const InputDecoration(hintText: 'Batch name (what changed)')),
                      ),
                      SizedBox(
                        width: 180,
                        child: DropdownButtonFormField<String>(
                          initialValue: language,
                          items: [for (final l in languages) DropdownMenuItem(value: l, child: Text(l))],
                          onChanged: (v) => setState(() => language = v ?? language),
                        ),
                      ),
                      FilledButton.icon(onPressed: add, icon: const Icon(Icons.playlist_add, size: 18), label: const Text('Add to queue')),
                    ]),
                  ]),
                ),
              ),
              for (final l in lists) ...[
                const SizedBox(height: 16),
                _ListCard(
                  list: l,
                  started: {for (final b in batches) b['batch'] as String},
                  onStart: (urls, name) => _call(() => Api.enqueue(urls, language, name)),
                ),
              ],
              const SizedBox(height: 16),
              Row(children: [
                Text(
                  s == null ? 'Queue' : '$waiting waiting${s['running'] != null ? ' · 1 running' : ''}${paused ? ' · paused' : ''}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const Spacer(),
                if (s?['running'] != null)
                  TextButton.icon(
                    onPressed: () => web.window.open('/?run=${s!['running']}', '_blank'),
                    icon: const Icon(Icons.live_tv, size: 18),
                    label: const Text('Watch live'),
                  ),
                const SizedBox(width: 8),
                TextButton.icon(onPressed: copyFailures, icon: const Icon(Icons.history, size: 18), label: const Text('Failure history')),
                const SizedBox(width: 8),
                if (s != null)
                  OutlinedButton.icon(
                    onPressed: () => _call(() => Api.pauseQueue(!paused)),
                    icon: Icon(paused ? Icons.play_arrow : Icons.pause, size: 18),
                    label: Text(paused ? 'Resume' : 'Pause after this one'),
                  ),
                const SizedBox(width: 8),
                IconButton(tooltip: 'Refresh', onPressed: load, icon: const Icon(Icons.refresh)),
              ]),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Palette.danger))),
              const SizedBox(height: 8),
              if (s != null && batches.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Nothing in the queue yet.'))),
              for (final b in batches) ...[
                _BatchCard(
                  summary: b,
                  items: _items.where((i) => i['batch'] == b['batch']).toList(),
                  open: openBatch == b['batch'],
                  onToggle: () => setState(() => openBatch = openBatch == b['batch'] ? null : b['batch'] as String),
                  onReport: () => copyReport(b['batch'] as String),
                  onAgain: () => again(b['batch'] as String),
                  onClear: () => _call(() => Api.removeFromQueue(batch: b['batch'] as String)),
                  onVerdict: () async {
                    final verdict = await _askVerdict(context, b['batch'] as String, b['feedback'] as Map<String, dynamic>?);
                    if (verdict != null) await _call(() => Api.batchFeedback(b['batch'] as String, verdict.stars, verdict.note));
                  },
                  onRemove: (id) => _call(() => Api.removeFromQueue(id: id)),
                  onStop: (runId) => Api.stop(runId).then((_) => load(), onError: (Object e) => setState(() => error = '$e')),
                ),
                const SizedBox(height: 12),
              ],
            ]),
          ),
        ),
      ]),
    );
  }
}

// A saved list, ten websites at a time: each block is its own batch, so its report
// says how the agents did before the next ten.
class _ListCard extends StatelessWidget {
  const _ListCard({required this.list, required this.started, required this.onStart});
  final Map<String, dynamic> list;
  final Set<String> started;
  final void Function(List<String> urls, String batch) onStart;

  static const block = 10;

  @override
  Widget build(BuildContext context) {
    final name = list['name'] as String;
    final urls = (list['urls'] as List).cast<String>();
    return Card(
      color: Colors.white,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('$name · ${urls.length} websites', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const Text('Ten at a time, in the language above. Each block is its own batch.', style: TextStyle(color: Palette.muted)),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (var from = 0; from < urls.length; from += block)
              Builder(builder: (context) {
                final to = (from + block).clamp(0, urls.length);
                final batch = '$name ${from + 1}-$to';
                final done = started.contains(batch);
                return OutlinedButton.icon(
                  onPressed: done ? null : () => onStart(urls.sublist(from, to), batch),
                  icon: Icon(done ? Icons.check : Icons.play_arrow, size: 18),
                  label: Text(done ? '${from + 1}–$to' : 'Start ${from + 1}–$to'),
                );
              }),
          ]),
        ]),
      ),
    );
  }
}

class _BatchCard extends StatelessWidget {
  const _BatchCard({
    required this.summary,
    required this.items,
    required this.open,
    required this.onToggle,
    required this.onReport,
    required this.onAgain,
    required this.onClear,
    required this.onVerdict,
    required this.onRemove,
    required this.onStop,
  });

  final Map<String, dynamic> summary;
  final List<Map<String, dynamic>> items;
  final bool open;
  final VoidCallback onToggle;
  final VoidCallback onReport;
  final VoidCallback onAgain;
  final VoidCallback onClear;
  final VoidCallback onVerdict;
  final ValueChanged<int> onRemove;
  final ValueChanged<String> onStop;

  @override
  Widget build(BuildContext context) {
    final b = summary;
    final verdict = b['feedback'] as Map<String, dynamic>?;
    String n(dynamic v, [String suffix = '']) => v == null ? '–' : '$v$suffix';
    final pairs = [
      for (final key in ['checks', 'lint', 'errors'])
        for (final p in (b[key] as List? ?? const [])) '${(p as List)[0]} ×${p[1]}',
    ];
    return Card(
      color: Colors.white,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          onTap: onToggle,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Icon(open ? Icons.expand_less : Icons.expand_more, color: Palette.muted),
                const SizedBox(width: 8),
                Expanded(child: Text(b['batch'] as String, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15))),
                Text('${b['done']}/${b['total']} done${(b['failed'] as int) > 0 ? ' · ${b['failed']} failed' : ''}', style: const TextStyle(color: Palette.muted)),
              ]),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                _Stat('Set score', n(b['setScore'], '/10')),
                _Stat('Slides approved', n(b['approvedPct'], ' %')),
                _Stat('First pass', n(b['firstPassPct'], ' %')),
                _Stat('Rounds per slide', n(b['roundsPerSlide'])),
                _Stat('Per carousel', b['avgCost'] == null ? '–' : 'US\$${b['avgCost']}'),
                _Stat('Minutes', n(b['avgMinutes'])),
                _Stat('Spent', 'US\$${b['totalCost']}'),
              ]),
              if (pairs.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('Fails most: ${pairs.take(6).join(' · ')}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
              ],
              if (verdict != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(color: Palette.border.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(8)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (verdict['stars'] != null) Text('Your verdict: ${'★' * (verdict['stars'] as int)}${'☆' * (5 - (verdict['stars'] as int))}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (verdict['note'] != null) ...[
                      const SizedBox(height: 4),
                      Text('“${verdict['note']}”', style: const TextStyle(fontSize: 13)),
                      const SizedBox(height: 2),
                      const Text('Every agent reads it from the next carousel on.', style: TextStyle(fontSize: 12, color: Palette.muted)),
                    ],
                  ]),
                ),
              ],
              const SizedBox(height: 10),
              Wrap(spacing: 8, children: [
                TextButton.icon(onPressed: onVerdict, icon: const Icon(Icons.star_outline_rounded, size: 16), label: Text(verdict == null ? 'Rate the batch' : 'Edit verdict')),
                TextButton.icon(onPressed: onReport, icon: const Icon(Icons.copy, size: 16), label: const Text('Copy report')),
                TextButton.icon(onPressed: onAgain, icon: const Icon(Icons.replay, size: 16), label: const Text('Run again')),
                if ((b['waiting'] as int) > 0) TextButton.icon(onPressed: onClear, icon: const Icon(Icons.clear_all, size: 16), label: const Text('Remove waiting')),
              ]),
            ]),
          ),
        ),
        if (open) ...[
          const Divider(height: 1),
          for (final i in items) _ItemRow(item: i, onRemove: onRemove, onStop: onStop),
        ],
      ]),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(border: Border.all(color: Palette.border), borderRadius: BorderRadius.circular(10)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(label, style: const TextStyle(color: Palette.faint, fontSize: 12)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        ]),
      );
}

const _statusColors = {
  'waiting': Palette.faint,
  'running': Palette.primary,
  'done': Color(0xFF0E8A6A),
  'failed': Palette.danger,
  'stopped': Color(0xFFC2410C),
};

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.item, required this.onRemove, required this.onStop});
  final Map<String, dynamic> item;
  final ValueChanged<int> onRemove;
  final ValueChanged<String> onStop;

  @override
  Widget build(BuildContext context) {
    final status = item['status'] as String;
    final m = item['metrics'] as Map<String, dynamic>?;
    final runId = item['runId'] as String?;
    final detail = m == null
        ? (item['note'] as String? ?? '')
        : m['error'] as String? ??
            [
              if (m['setScore'] != null) 'set ${m['setScore']}/10',
              '${m['approved']}/${m['slides']} approved',
              '${m['firstPass']} first pass',
              'US\$${m['cost']}',
              '${m['minutes']} min',
            ].join(' · ');
    return ListTile(
      dense: true,
      leading: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: _statusColors[status]!.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(6)),
        child: Text(status, style: TextStyle(color: _statusColors[status], fontWeight: FontWeight.w700, fontSize: 12)),
      ),
      title: Text(Uri.tryParse(item['url'] as String)?.host.replaceFirst('www.', '') ?? item['url'] as String),
      subtitle: detail.isEmpty ? null : Text(detail, maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        if (runId != null)
          IconButton(tooltip: 'Open the run', icon: const Icon(Icons.open_in_new, size: 18), onPressed: () => web.window.open('/?run=$runId', '_blank')),
        if (status == 'running' && runId != null) IconButton(tooltip: 'Stop this run', icon: const Icon(Icons.stop_circle_outlined, size: 18), onPressed: () => onStop(runId)),
        if (status == 'waiting') IconButton(tooltip: 'Remove', icon: const Icon(Icons.close, size: 18), onPressed: () => onRemove(item['id'] as int)),
      ]),
    );
  }
}

// The owner's verdict on a whole batch: stars and, in their words, what every carousel
// should do from now on. Null when cancelled; clearing both removes the verdict.
Future<({int? stars, String note})?> _askVerdict(BuildContext context, String batch, Map<String, dynamic>? current) {
  final text = TextEditingController(text: current?['note'] as String? ?? '');
  var stars = current?['stars'] as int?;
  return showDialog<({int? stars, String note})>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: Text('Batch “$batch”'),
        content: SizedBox(
          width: 520,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('How good is the batch as a whole?', style: TextStyle(fontWeight: FontWeight.w600)),
            Row(children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  tooltip: '$i of 5',
                  onPressed: () => setState(() => stars = stars == i ? null : i),
                  icon: Icon((stars ?? 0) >= i ? Icons.star_rounded : Icons.star_outline_rounded,
                      color: (stars ?? 0) >= i ? const Color(0xFFF5A524) : const Color(0xFFC7C7C7)),
                ),
            ]),
            const SizedBox(height: 12),
            const Text('What should change in every carousel from now on?', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            const Text('The director, the art director and the critic read it on every next carousel. Turn it off in Learned › Direction.',
                style: TextStyle(fontSize: 12, color: Palette.muted)),
            const SizedBox(height: 8),
            TextField(
              controller: text,
              autofocus: true,
              minLines: 4,
              maxLines: 10,
              decoration: const InputDecoration(hintText: 'e.g. Shorter headlines, more of the brand color, never beige, products cut out instead of in boxes…'),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, (stars: stars, note: text.text.trim())), child: const Text('Save')),
        ],
      ),
    ),
  );
}
