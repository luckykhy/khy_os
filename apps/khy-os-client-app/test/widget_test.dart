import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/main.dart';

void main() {
  testWidgets('khy-os app builds', (WidgetTester tester) async {
    await tester.pumpWidget(const KhyOsApp());
    expect(find.byType(KhyOsApp), findsOneWidget);
  });
}
