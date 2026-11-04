import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import 'api.dart';
import 'main.dart' show Palette;

// Images the owner picks from their computer, as (file name, base64). Never completes
// when the picker is cancelled: nothing changes then.
Future<List<(String, String)>> pickImages() {
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = 'image/*'
    ..multiple = true;
  final done = Completer<List<(String, String)>>();
  input.onchange = ((web.Event _) {
    unawaited(() async {
      final files = input.files;
      final out = <(String, String)>[];
      for (var i = 0; i < (files?.length ?? 0); i++) {
        final file = files!.item(i)!;
        final reader = web.FileReader();
        final loaded = Completer<void>();
        reader.onload = ((web.Event _) => loaded.complete()).toJS;
        reader.readAsDataURL(file);
        await loaded.future;
        final url = (reader.result as JSString).toDart;
        out.add((file.name, url.substring(url.indexOf(',') + 1)));
      }
      done.complete(out);
    }());
  }).toJS;
  input.click();
  return done.future;
}

// The style gallery Create starts from: the agents decide, or the carousel follows a
// design the owner uploaded or one of our carousels they rated 5 stars.
class StyleGallery extends StatelessWidget {
  const StyleGallery({super.key, required this.styles, required this.selected, required this.uploading, required this.onSelect, required this.onUpload, required this.onDelete});
  final List<Map<String, dynamic>> styles;
  final String? selected;
  final bool uploading;
  final ValueChanged<String?> onSelect;
  final VoidCallback onUpload;
  final ValueChanged<String> onDelete;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('Pick a style', textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -0.4)),
      const SizedBox(height: 8),
      const Text(
        "Designs you like and your 5 ★ carousels. The agents follow its layout, type and color approach with your brand's own colors and photos, never its image.",
        textAlign: TextAlign.center,
        style: TextStyle(color: Palette.muted, fontSize: 14, height: 1.5),
      ),
      const SizedBox(height: 22),
      Wrap(
        alignment: WrapAlignment.center,
        spacing: 14,
        runSpacing: 18,
        children: [
          _Tile(
            selected: selected == null,
            onTap: () => onSelect(null),
            title: 'The agents decide',
            child: const Center(child: Icon(Icons.auto_awesome, color: Palette.primary, size: 34)),
          ),
          _Tile(
            selected: false,
            onTap: uploading ? null : onUpload,
            title: uploading ? 'Reading the style…' : 'Upload designs',
            child: Center(
              child: uploading
                  ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Icon(Icons.add_photo_alternate_outlined, color: Palette.faint, size: 34),
            ),
          ),
          for (final s in styles)
            _Tile(
              selected: selected == s['id'],
              onTap: () => onSelect(s['id'] as String),
              title: s['title'] as String,
              badge: s['source'] == 'carousel' ? 'Ours' : null,
              tooltip: (s['style'] as Map?)?['notes'] as String?,
              onDelete: () => onDelete(s['id'] as String),
              child: _Thumb(url: Api.fileUrl(s['url'] as String)),
            ),
        ],
      ),
    ]);
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.selected, required this.onTap, required this.title, required this.child, this.badge, this.tooltip, this.onDelete});
  final bool selected;
  final VoidCallback? onTap;
  final String title;
  final Widget child;
  final String? badge;
  final String? tooltip;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final tile = SizedBox(
      width: 168,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: 4 / 5,
            child: Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: selected ? Palette.primary : Palette.border, width: selected ? 3 : 1),
              ),
              child: Stack(fit: StackFit.expand, children: [
                child,
                if (badge != null)
                  Positioned(
                    left: 8,
                    top: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(color: Palette.primary, borderRadius: BorderRadius.circular(20)),
                      child: Text(badge!, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                    ),
                  ),
                if (onDelete != null)
                  Positioned(
                    right: 4,
                    top: 4,
                    child: IconButton.filledTonal(
                      tooltip: 'Remove from the gallery',
                      visualDensity: VisualDensity.compact,
                      iconSize: 16,
                      onPressed: onDelete,
                      icon: const Icon(Icons.close),
                    ),
                  ),
              ]),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, fontWeight: selected ? FontWeight.w700 : FontWeight.w500, color: selected ? Palette.primary : Palette.ink),
        ),
      ]),
    );
    return tooltip == null || tooltip!.isEmpty ? tile : Tooltip(message: tooltip!, waitDuration: const Duration(milliseconds: 500), child: tile);
  }
}


// A style's picture: a pulsing placeholder while it loads, a retry if it fails (the
// server restarting, say), and decoded small so 60 of them load fast.
class _Thumb extends StatefulWidget {
  const _Thumb({required this.url});
  final String url;

  @override
  State<_Thumb> createState() => _ThumbState();
}

class _ThumbState extends State<_Thumb> {
  int attempt = 0;

  @override
  Widget build(BuildContext context) {
    return Image.network(
      attempt == 0 ? widget.url : '${widget.url}?retry=$attempt',
      key: ValueKey(attempt),
      fit: BoxFit.cover,
      cacheWidth: 420,
      gaplessPlayback: true,
      loadingBuilder: (context, child, progress) => progress == null
          ? child
          : Container(
              color: Palette.ground,
              alignment: Alignment.center,
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  value: progress.expectedTotalBytes == null ? null : progress.cumulativeBytesLoaded / progress.expectedTotalBytes!,
                ),
              ),
            ),
      errorBuilder: (context, _, _) => Container(
        color: Palette.ground,
        alignment: Alignment.center,
        child: TextButton.icon(
          onPressed: () => setState(() => attempt++),
          icon: const Icon(Icons.refresh_rounded, size: 18),
          label: const Text('Retry'),
        ),
      ),
    );
  }
}
