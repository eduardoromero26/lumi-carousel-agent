import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

import 'api.dart';
import 'i18n.dart';
import 'main.dart' show Palette, languages, mono;
import 'room.dart' show openEditView;

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
  // The board (every website as a ticket in its column) or the batches with their numbers.
  bool board = true;
  // The board shows one batch, or all of them (null).
  String? boardBatch;
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Report of "{name}" copied'.trf({'name': name}))));
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  Future<void> copyFailures() async {
    try {
      await Clipboard.setData(ClipboardData(text: await Api.failures()));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failure history copied'.tr)));
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
                    Text('Add websites'.tr, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 4),
                    Text('One per line. Each one becomes a carousel, one after another.'.tr, style: const TextStyle(color: Palette.muted)),
                    const SizedBox(height: 12),
                    TextField(controller: urls, minLines: 3, maxLines: 8, decoration: const InputDecoration(hintText: 'tienda.mx\nclinica.com.mx')),
                    const SizedBox(height: 12),
                    Wrap(spacing: 12, runSpacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      SizedBox(
                        width: 280,
                        child: TextField(controller: batch, decoration: InputDecoration(hintText: 'Batch name (what changed)'.tr)),
                      ),
                      SizedBox(
                        width: 180,
                        child: DropdownButtonFormField<String>(
                          initialValue: language,
                          items: [for (final l in languages) DropdownMenuItem(value: l, child: Text(l))],
                          onChanged: (v) => setState(() => language = v ?? language),
                        ),
                      ),
                      FilledButton.icon(onPressed: add, icon: const Icon(Icons.playlist_add, size: 18), label: Text('Add to queue'.tr)),
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
                  s == null
                      ? 'Queue'.tr
                      : '{n} waiting'.trf({'n': waiting}) + (s['running'] != null ? ' · ${'1 running'.tr}' : '') + (paused ? ' · ${'paused'.tr}' : ''),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const Spacer(),
                if (s?['running'] != null)
                  TextButton.icon(
                    onPressed: () => web.window.open('/?run=${s!['running']}', '_blank'),
                    icon: const Icon(Icons.live_tv, size: 18),
                    label: Text('Watch live'.tr),
                  ),
                const SizedBox(width: 8),
                TextButton.icon(onPressed: copyFailures, icon: const Icon(Icons.history, size: 18), label: Text('Failure history'.tr)),
                const SizedBox(width: 8),
                if (s != null)
                  OutlinedButton.icon(
                    onPressed: () => _call(() => Api.pauseQueue(!paused)),
                    icon: Icon(paused ? Icons.play_arrow : Icons.pause, size: 18),
                    label: Text(paused ? 'Resume'.tr : 'Pause after this one'.tr),
                  ),
                const SizedBox(width: 8),
                IconButton(tooltip: 'Refresh'.tr, onPressed: load, icon: const Icon(Icons.refresh)),
              ]),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Palette.danger))),
              const SizedBox(height: 8),
              // Loading: nothing came back yet and nothing failed.
              if (s == null && error == null) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
              if (s == null && error != null)
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Center(child: OutlinedButton.icon(onPressed: load, icon: const Icon(Icons.refresh, size: 18), label: Text('Try again'.tr))),
                ),
              if (s != null && batches.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Center(child: Text('Nothing in the queue yet.'.tr))),
              if (s != null && batches.isNotEmpty) ...[
                Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  SegmentedButton<bool>(
                    showSelectedIcon: false,
                    segments: [
                      ButtonSegment(value: true, icon: const Icon(Icons.view_kanban_outlined, size: 18), label: Text('Board'.tr)),
                      ButtonSegment(value: false, icon: const Icon(Icons.bar_chart_rounded, size: 18), label: Text('Batches'.tr)),
                    ],
                    selected: {board},
                    onSelectionChanged: (v) => setState(() => board = v.first),
                  ),
                  if (board) ...[
                    const SizedBox(width: 8),
                    ChoiceChip(label: Text('All batches'.tr), selected: boardBatch == null, onSelected: (_) => setState(() => boardBatch = null)),
                    for (final b in batches.take(8))
                      ChoiceChip(label: Text(b['batch'] as String), selected: boardBatch == b['batch'], onSelected: (_) => setState(() => boardBatch = b['batch'] as String)),
                  ],
                ]),
                const SizedBox(height: 12),
              ],
              if (board && s != null && batches.isNotEmpty)
                _Board(
                  items: boardBatch == null ? _items : _items.where((i) => i['batch'] == boardBatch).toList(),
                  onRemove: (id) => _call(() => Api.removeFromQueue(id: id)),
                  onStop: (runId) => Api.stop(runId).then((_) => load(), onError: (Object e) => setState(() => error = '$e')),
                ),
              if (!board)
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
          Text('{name} · {n} websites'.trf({'name': name, 'n': urls.length}), style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('Ten at a time, in the language above. Each block is its own batch.'.tr, style: const TextStyle(color: Palette.muted)),
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
                  label: Text(done ? '${from + 1}–$to' : 'Start {from}–{to}'.trf({'from': from + 1, 'to': to})),
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
                Text('{done}/{total} done'.trf({'done': b['done'], 'total': b['total']}) + ((b['failed'] as int) > 0 ? ' · ${'{n} failed'.trf({'n': b['failed']})}' : ''), style: const TextStyle(color: Palette.muted)),
              ]),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                _Stat('Set score'.tr, n(b['setScore'], '/10')),
                _Stat('Slides approved'.tr, n(b['approvedPct'], ' %')),
                _Stat('First pass'.tr, n(b['firstPassPct'], ' %')),
                _Stat('Rounds per slide'.tr, n(b['roundsPerSlide'])),
                _Stat('Per carousel'.tr, b['avgCost'] == null ? '–' : 'US\$${b['avgCost']}'),
                _Stat('Minutes'.tr, n(b['avgMinutes'])),
                _Stat('Spent'.tr, 'US\$${b['totalCost']}'),
              ]),
              if (pairs.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('Fails most: {list}'.trf({'list': pairs.take(6).join(' · ')}), style: const TextStyle(color: Palette.muted, fontSize: 13)),
              ],
              if (verdict != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(color: Palette.border.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(8)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (verdict['stars'] != null) Text('Your verdict: {stars}'.trf({'stars': '${'★' * (verdict['stars'] as int)}${'☆' * (5 - (verdict['stars'] as int))}'}), style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (verdict['note'] != null) ...[
                      const SizedBox(height: 4),
                      Text('“${verdict['note']}”', style: const TextStyle(fontSize: 13)),
                      const SizedBox(height: 2),
                      Text('Every agent reads it from the next carousel on.'.tr, style: const TextStyle(fontSize: 12, color: Palette.muted)),
                    ],
                  ]),
                ),
              ],
              const SizedBox(height: 10),
              Wrap(spacing: 8, children: [
                TextButton.icon(onPressed: onVerdict, icon: const Icon(Icons.star_outline_rounded, size: 16), label: Text(verdict == null ? 'Rate the batch'.tr : 'Edit verdict'.tr)),
                TextButton.icon(onPressed: onReport, icon: const Icon(Icons.copy, size: 16), label: Text('Copy report'.tr)),
                TextButton.icon(onPressed: onAgain, icon: const Icon(Icons.replay, size: 16), label: Text('Run again'.tr)),
                if ((b['waiting'] as int) > 0) TextButton.icon(onPressed: onClear, icon: const Icon(Icons.clear_all, size: 16), label: Text('Remove waiting'.tr)),
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

// The queue as a kanban board: every website is a ticket that moves from waiting to in
// progress to ready, or to the problems column when its run failed or was stopped.
class _Board extends StatelessWidget {
  const _Board({required this.items, required this.onRemove, required this.onStop});
  final List<Map<String, dynamic>> items;
  final ValueChanged<int> onRemove;
  final ValueChanged<String> onStop;

  // A column with hundreds of done tickets would bury the board: the newest ones show.
  static const shown = 30;

  @override
  Widget build(BuildContext context) {
    List<Map<String, dynamic>> of(Set<String> statuses, {bool newest = false}) {
      final list = items.where((i) => statuses.contains(i['status'])).toList();
      if (newest) list.sort((a, b) => '${b['finishedAt'] ?? ''}'.compareTo('${a['finishedAt'] ?? ''}'));
      return list;
    }

    final columns = [
      ('Waiting'.tr, Palette.faint, of({'waiting'})),
      ('In progress'.tr, Palette.primary, of({'running'})),
      ('Ready to publish'.tr, const Color(0xFF0E8A6A), of({'done'}, newest: true)),
      ('Needs attention'.tr, Palette.danger, of({'failed', 'stopped'}, newest: true)),
    ];
    return LayoutBuilder(builder: (context, box) {
      // Wide: the four columns share the width. Narrow: they keep their width and scroll sideways.
      final wide = box.maxWidth >= 1000;
      final cols = [
        for (final (title, color, list) in columns)
          _Column(title: title, color: color, items: list, shown: shown, onRemove: onRemove, onStop: onStop),
      ];
      return wide
          ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (var i = 0; i < cols.length; i++) ...[if (i > 0) const SizedBox(width: 12), Expanded(child: cols[i])],
            ])
          : SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (var i = 0; i < cols.length; i++) ...[if (i > 0) const SizedBox(width: 12), SizedBox(width: 270, child: cols[i])],
              ]),
            );
    });
  }
}

class _Column extends StatelessWidget {
  const _Column({required this.title, required this.color, required this.items, required this.shown, required this.onRemove, required this.onStop});
  final String title;
  final Color color;
  final List<Map<String, dynamic>> items;
  final int shown;
  final ValueChanged<int> onRemove;
  final ValueChanged<String> onStop;

  @override
  Widget build(BuildContext context) {
    final more = items.length - shown;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: const Color(0xFFF1F0F6), borderRadius: BorderRadius.circular(14), border: Border.all(color: Palette.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 2, 4, 10),
          child: Row(children: [
            Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14))),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: Palette.border)),
              child: Text('${items.length}', style: mono(size: 11, color: Palette.muted, weight: FontWeight.w700)),
            ),
          ]),
        ),
        if (items.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 18), child: Text('No tickets here.'.tr, textAlign: TextAlign.center, style: const TextStyle(color: Palette.faint, fontSize: 12.5))),
        for (final (k, item) in items.take(shown).indexed) ...[
          if (k > 0) const SizedBox(height: 8),
          _Ticket(key: ValueKey(item['id']), item: item, place: item['status'] == 'waiting' ? k + 1 : null, onRemove: onRemove, onStop: onStop),
        ],
        if (more > 0)
          Padding(padding: const EdgeInsets.only(top: 10), child: Text('+{n} more'.trf({'n': more}), textAlign: TextAlign.center, style: const TextStyle(color: Palette.muted, fontSize: 12.5))),
      ]),
    );
  }
}

class _Ticket extends StatefulWidget {
  const _Ticket({super.key, required this.item, required this.place, required this.onRemove, required this.onStop});
  final Map<String, dynamic> item;
  // Its place in line, for a waiting ticket.
  final int? place;
  final ValueChanged<int> onRemove;
  final ValueChanged<String> onStop;

  @override
  State<_Ticket> createState() => _TicketState();
}

class _TicketState extends State<_Ticket> with SingleTickerProviderStateMixin {
  late final pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void initState() {
    super.initState();
    if (widget.item['status'] == 'running') pulse.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_Ticket old) {
    super.didUpdateWidget(old);
    final running = widget.item['status'] == 'running';
    if (running && !pulse.isAnimating) pulse.repeat(reverse: true);
    if (!running && pulse.isAnimating) pulse.stop();
  }

  @override
  void dispose() {
    pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final status = item['status'] as String;
    final m = item['metrics'] as Map<String, dynamic>?;
    final runId = item['runId'] as String?;
    final host = Uri.tryParse(item['url'] as String)?.host.replaceFirst('www.', '') ?? item['url'] as String;
    final color = _statusColors[status] ?? Palette.faint;
    final problem = status == 'failed' || status == 'stopped' ? (m?['error'] as String? ?? item['note'] as String? ?? '') : '';
    final cover = status == 'done' && runId != null && (m?['slides'] as int? ?? 0) > 0;
    return Material(
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: status == 'running' ? Palette.primary.withValues(alpha: 0.5) : Palette.border)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: runId == null ? null : () => openEditView(runId),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (cover)
            SizedBox(
              height: 110,
              child: Image.network(
                Api.fileUrl('/files/$runId/slide-1.png'),
                fit: BoxFit.cover,
                alignment: Alignment.topCenter,
                errorBuilder: (_, _, _) => const ColoredBox(color: Color(0xFFF4F3F8)),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text('#${item['id']}', style: mono(size: 11, color: Palette.faint, weight: FontWeight.w700)),
                const SizedBox(width: 6),
                Expanded(child: Text(host, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5))),
                if (status == 'waiting')
                  IconButton(tooltip: 'Remove'.tr, visualDensity: VisualDensity.compact, iconSize: 16, onPressed: () => widget.onRemove(item['id'] as int), icon: const Icon(Icons.close, color: Palette.faint)),
                if (status == 'running' && runId != null)
                  IconButton(tooltip: 'Stop this run'.tr, visualDensity: VisualDensity.compact, iconSize: 17, onPressed: () => widget.onStop(runId), icon: const Icon(Icons.stop_circle_outlined, color: Palette.danger)),
              ]),
              const SizedBox(height: 4),
              Text('${item['batch'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: Palette.faint)),
              const SizedBox(height: 8),
              if (status == 'waiting')
                Text('#{n} in line'.trf({'n': widget.place}), style: const TextStyle(fontSize: 12, color: Palette.muted)),
              if (status == 'running')
                Row(children: [
                  FadeTransition(
                    opacity: Tween(begin: 0.3, end: 1.0).animate(pulse),
                    child: Container(width: 8, height: 8, decoration: const BoxDecoration(color: Palette.danger, shape: BoxShape.circle)),
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text('The agents are on it'.tr, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Palette.primary))),
                  Text('Watch live'.tr, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Palette.primary)),
                  const Icon(Icons.arrow_forward_rounded, size: 14, color: Palette.primary),
                ]),
              if (status == 'done' && m != null)
                Wrap(spacing: 6, runSpacing: 4, children: [
                  if (m['setScore'] != null) _Chip('{n}/10'.trf({'n': m['setScore']}), const Color(0xFF0E8A6A)),
                  _Chip('{a}/{b} approved'.trf({'a': m['approved'], 'b': m['slides']}), Palette.muted),
                  _Chip('US\$${m['cost']}', Palette.muted),
                  _Chip('${m['minutes']} min', Palette.muted),
                ]),
              if (problem.isNotEmpty)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Padding(padding: const EdgeInsets.only(top: 1), child: Icon(status == 'stopped' ? Icons.pause_circle_outline : Icons.error_outline_rounded, size: 14, color: color)),
                  const SizedBox(width: 6),
                  Expanded(child: Text(problem, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: color, height: 1.35))),
                ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(6)),
        child: Text(text, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: color)),
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
              if (m['setScore'] != null) 'set {n}/10'.trf({'n': m['setScore']}),
              '{a}/{b} approved'.trf({'a': m['approved'], 'b': m['slides']}),
              '{n} first pass'.trf({'n': m['firstPass']}),
              'US\$${m['cost']}',
              '${m['minutes']} min',
            ].join(' · ');
    return ListTile(
      dense: true,
      leading: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: _statusColors[status]!.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(6)),
        child: Text(status.tr, style: TextStyle(color: _statusColors[status], fontWeight: FontWeight.w700, fontSize: 12)),
      ),
      title: Text(Uri.tryParse(item['url'] as String)?.host.replaceFirst('www.', '') ?? item['url'] as String),
      subtitle: detail.isEmpty ? null : Text(detail, maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        if (runId != null)
          IconButton(tooltip: 'Open the run'.tr, icon: const Icon(Icons.open_in_new, size: 18), onPressed: () => web.window.open('/?run=$runId', '_blank')),
        if (status == 'running' && runId != null) IconButton(tooltip: 'Stop this run'.tr, icon: const Icon(Icons.stop_circle_outlined, size: 18), onPressed: () => onStop(runId)),
        if (status == 'waiting') IconButton(tooltip: 'Remove'.tr, icon: const Icon(Icons.close, size: 18), onPressed: () => onRemove(item['id'] as int)),
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
        title: Text('Batch “{batch}”'.trf({'batch': batch})),
        content: SizedBox(
          width: 520,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('How good is the batch as a whole?'.tr, style: const TextStyle(fontWeight: FontWeight.w600)),
            Row(children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  tooltip: '{i} of 5'.trf({'i': i}),
                  onPressed: () => setState(() => stars = stars == i ? null : i),
                  icon: Icon((stars ?? 0) >= i ? Icons.star_rounded : Icons.star_outline_rounded,
                      color: (stars ?? 0) >= i ? const Color(0xFFF5A524) : const Color(0xFFC7C7C7)),
                ),
            ]),
            const SizedBox(height: 12),
            Text('What should change in every carousel from now on?'.tr, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('The director, the art director and the critic read it on every next carousel. Turn it off in Learned › Direction.'.tr,
                style: const TextStyle(fontSize: 12, color: Palette.muted)),
            const SizedBox(height: 8),
            TextField(
              controller: text,
              autofocus: true,
              minLines: 4,
              maxLines: 10,
              decoration: InputDecoration(hintText: 'e.g. Shorter headlines, more of the brand color, never beige, products cut out instead of in boxes…'.tr),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: Text('Cancel'.tr)),
          FilledButton(onPressed: () => Navigator.pop(context, (stars: stars, note: text.text.trim())), child: Text('Save'.tr)),
        ],
      ),
    ),
  );
}
