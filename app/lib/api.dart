import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

// Empty when the server serves the app (same origin); set it with
// --dart-define=API_URL=http://localhost:8787 for `flutter run`.
const _apiUrl = String.fromEnvironment('API_URL');
String get apiUrl => _apiUrl.isNotEmpty ? _apiUrl : web.window.location.origin;

class RunEvent {
  RunEvent.fromJson(Map<String, dynamic> j)
      : seq = j['seq'] as int,
        type = j['type'] as String,
        agent = j['agent'] as String,
        text = j['text'] as String,
        slide = j['slide'] as int?,
        at = DateTime.tryParse(j['at'] as String? ?? ''),
        cost = (j['cost'] as num?)?.toDouble(),
        tokens = (j['tokens'] as num?)?.toInt(),
        data = j['data'];

  final int seq;
  final DateTime? at;
  // What the run had spent when this happened.
  final double? cost;
  final int? tokens;
  final String type;
  final String agent;
  final String text;
  final int? slide;
  final dynamic data;
}

// A list, or one string from an older run ("#a #b").
List<String> hashtagsOf(dynamic raw) => raw is List
    ? raw.map((h) => '$h').toList()
    : raw is String
        ? raw.split(RegExp(r'[\s,]+')).where((h) => h.isNotEmpty).toList()
        : const [];

class Api {
  static String fileUrl(String path) => '$apiUrl$path';

  static Future<String> createRun({
    String business = '',
    String url = '',
    required String language,
    required String goal,
    String audience = '',
    List<String> brandColors = const [],
    String? reference,
  }) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'brief': {
          if (business.isNotEmpty) 'business': business,
          if (url.isNotEmpty) 'url': url,
          'language': language,
          'goal': goal,
          if (audience.isNotEmpty) 'audience': audience,
          if (brandColors.isNotEmpty) 'brandColors': brandColors,
          'reference': ?reference,
        },
      }),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 201) throw Exception(body['error'] ?? 'Error ${res.statusCode}');
    return body['id'] as String;
  }

  static Future<void> editSlide(String runId, int n, String feedback) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs/$runId/slides/$n/edit'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'feedback': feedback}),
    );
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  // The website images the owner leaves out, while the analyst waits for them.
  static Future<void> pickImages(String runId, {List<String> include = const [], List<String> exclude = const []}) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs/$runId/images'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'include': include, 'exclude': exclude}),
    );
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  // The owner's changes to the director's plan, while it waits before the design.
  static Future<void> reviewPlan(String runId, List<Map<String, dynamic>> slides, String note, {List<String> exclude = const []}) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs/$runId/plan'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'slides': slides, if (note.isNotEmpty) 'note': note, if (exclude.isNotEmpty) 'exclude': exclude}),
    );
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  // The owner writes to the director in the team chat.
  static Future<void> chat(String runId, String text) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs/$runId/chat'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'text': text}),
    );
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  static Future<void> stop(String runId) async {
    final res = await http.post(Uri.parse('$apiUrl/api/runs/$runId/stop'));
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  // What the server has turned on: {reels: bool}.
  static Future<Map<String, dynamic>> config() async {
    final res = await http.get(Uri.parse('$apiUrl/api/config'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // The 30 s reel from the whole carousel.
  static Future<void> reel(String runId) async {
    final res = await http.post(Uri.parse('$apiUrl/api/runs/$runId/reel'));
    if (res.statusCode != 202) {
      throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
    }
  }

  // Every finished carousel, newest first, as the feed shows it.
  static Future<List<Map<String, dynamic>>> feed() async {
    final res = await http.get(Uri.parse('$apiUrl/api/feed'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  // The owner's vote on a carousel ("carousel"), a slide ("slide:2") or the reel ("reel"):
  // 1 likes, -1 dislikes, 0 takes it back; stars (1-5, the carousel only) set the like
  // themselves; the note is what's wrong. Returns the post's votes and stars.
  static Future<({Map<String, int> votes, int? stars})> vote(String runId, String target, int value, {int? stars, String? note}) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/runs/$runId/vote'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'target': target,
        'value': value,
        'stars': ?stars,
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      }),
    );
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (votes: (body['votes'] as Map<String, dynamic>).cast<String, int>(), stars: body['stars'] as int?);
  }

  // The style gallery: [{id, title, url, source, runId, style, at}], newest first.
  static Future<List<Map<String, dynamic>>> references() async {
    final res = await http.get(Uri.parse('$apiUrl/api/references'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  // A design the owner likes; the server reads its style with a vision model.
  static Future<Map<String, dynamic>> addReference(String name, String base64) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/references'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'name': name, 'base64': base64}),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 201) throw Exception(body['error'] ?? 'Error ${res.statusCode}');
    return body;
  }

  static Future<void> deleteReference(String id) async {
    final res = await http.delete(Uri.parse('$apiUrl/api/references/$id'));
    if (res.statusCode != 200) throw Exception((jsonDecode(res.body) as Map<String, dynamic>)['error'] ?? 'Error ${res.statusCode}');
  }

  // One of our carousels joins the gallery.
  static Future<Map<String, dynamic>> referenceFromRun(String runId) async {
    final res = await http.post(Uri.parse('$apiUrl/api/runs/$runId/reference'));
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 201) throw Exception(body['error'] ?? 'Error ${res.statusCode}');
    return body;
  }

  // What the votes say about each design choice.
  static Future<List<Map<String, dynamic>>> taste() async {
    final res = await http.get(Uri.parse('$apiUrl/api/taste'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  // The critic against the owner's votes: {votes, liked, judged, agree, rate, tooEasy, tooHard, batches}.
  static Future<Map<String, dynamic>> calibration() async {
    final res = await http.get(Uri.parse('$apiUrl/api/calibration'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // What the agents learned: shelves of cards, each {id?, title, text, evidence, tone, vote?, feedback?}.
  static Future<List<Map<String, dynamic>>> learned() async {
    final res = await http.get(Uri.parse('$apiUrl/api/learned'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  // The owner's vote on a lesson: 1 confirms it, -1 turns it off (the note says why), 0 takes it back.
  static Future<void> voteLearned(String id, int value, {String? note}) async {
    final res = await http.post(
      Uri.parse('$apiUrl/api/learned/vote'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'id': id, 'value': value, if (note != null && note.trim().isNotEmpty) 'note': note.trim()}),
    );
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
  }

  // The queue: {paused, busy, running, items, batches}.
  static Future<Map<String, dynamic>> queue() async {
    final res = await http.get(Uri.parse('$apiUrl/api/queue'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  static Future<Map<String, dynamic>> enqueue(List<String> urls, String language, String batch) => _queueCall(
        http.post(
          Uri.parse('$apiUrl/api/queue'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'urls': urls, 'language': language, 'batch': batch}),
        ),
      );

  // The saved lists of websites (server/lists/*.txt): [{name, urls}].
  static Future<List<Map<String, dynamic>>> lists() async {
    final res = await http.get(Uri.parse('$apiUrl/api/queue/lists'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>> pauseQueue(bool paused) => _queueCall(
        http.post(Uri.parse('$apiUrl/api/queue/pause'), headers: {'Content-Type': 'application/json'}, body: jsonEncode({'paused': paused})),
      );

  // The owner's verdict on a whole batch: stars and a direction every agent reads from then on.
  static Future<Map<String, dynamic>> batchFeedback(String batch, int? stars, String note) => _queueCall(
        http.post(Uri.parse('$apiUrl/api/queue/feedback'),
            headers: {'Content-Type': 'application/json'}, body: jsonEncode({'batch': batch, 'stars': stars, 'note': note})),
      );

  // One waiting website (id) or every waiting one of a batch.
  static Future<Map<String, dynamic>> removeFromQueue({int? id, String? batch}) => _queueCall(
        http.delete(id != null ? Uri.parse('$apiUrl/api/queue/$id') : Uri.parse('$apiUrl/api/queue').replace(queryParameters: {'batch': batch})),
      );

  static Future<String> batchReport(String batch) async {
    final res = await http.get(Uri.parse('$apiUrl/api/queue/report').replace(queryParameters: {'batch': batch}));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return utf8.decode(res.bodyBytes);
  }

  // Every failure seen in any batch, with examples and what fixed it before.
  static Future<String> failures() async {
    final res = await http.get(Uri.parse('$apiUrl/api/queue/failures'));
    if (res.statusCode != 200) throw Exception('Error ${res.statusCode}');
    return utf8.decode(res.bodyBytes);
  }

  static Future<Map<String, dynamic>> _queueCall(Future<http.Response> call) async {
    final res = await call;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 300) throw Exception(body['error'] ?? 'Error ${res.statusCode}');
    return body;
  }

  // Server-Sent Events: the server replays the run's history on connect, so
  // events are deduplicated by seq on the caller side.
  static Stream<RunEvent> events(String runId) {
    late web.EventSource source;
    final controller = StreamController<RunEvent>(onCancel: () => source.close());
    source = web.EventSource('$apiUrl/api/runs/$runId/events');
    source.onmessage = ((web.MessageEvent e) {
      final raw = (e.data as JSString).toDart;
      controller.add(RunEvent.fromJson(jsonDecode(raw) as Map<String, dynamic>));
    }).toJS;
    return controller.stream;
  }
}
