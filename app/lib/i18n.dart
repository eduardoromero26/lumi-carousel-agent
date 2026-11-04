import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import 'i18n/es_feed.dart';
import 'i18n/es_main.dart';
import 'i18n/es_queue.dart';
import 'i18n/es_room.dart';

// The UI's language: 'en' or 'es'. The English text is the key; Spanish comes from the
// catalogs in i18n/, one per area. What the agents write (chat, critic, plan) stays as is.
final appLanguage = ValueNotifier<String>(_initial());

String _initial() {
  try {
    final saved = web.window.localStorage.getItem('lang');
    if (saved == 'en' || saved == 'es') return saved!;
  } catch (_) {}
  return web.window.navigator.language.startsWith('es') ? 'es' : 'en';
}

void setLanguage(String lang) {
  appLanguage.value = lang;
  try {
    web.window.localStorage.setItem('lang', lang);
  } catch (_) {}
}

// Not const: a key shared by two catalogs is fine, as long as both say the same thing.
final Map<String, String> _es = {...esMain, ...esRoom, ...esFeed, ...esQueue};

extension Tr on String {
  // 'Choose its photo'.tr
  String get tr => appLanguage.value == 'es' ? (_es[this] ?? this) : this;

  // '{n} slides'.trf({'n': 3}): the placeholders are filled after translating.
  String trf(Map<String, Object?> values) {
    var out = tr;
    values.forEach((k, v) => out = out.replaceAll('{$k}', '$v'));
    return out;
  }
}
