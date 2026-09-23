import java.io.*;
import java.util.*;
import java.util.zip.*;

public class TmpKoh {
  public static void main(String[] args) throws Exception {
    String apk = args[0];
    String search = args[1];
    ZipFile zf = new ZipFile(apk);
    Enumeration<? extends ZipEntry> e = zf.entries();
    int totalHits = 0;
    StringBuilder sb = new StringBuilder();
    int innerApkCount = 0;
    while (e.hasMoreElements()) {
      ZipEntry ze = e.nextElement();
      if (!ze.getName().toLowerCase().endsWith(".apk")) continue;
      innerApkCount++;
      InputStream is = zf.getInputStream(ze);
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[65536];
      int n;
      while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
      byte[] data = bos.toByteArray();
      String s = new String(data, "ISO-8859-1");
      int found = 0;
      int idx = 0;
      while ((idx = s.indexOf(search, idx)) >= 0) { found++; idx += search.length(); }
      if (found > 0) {
        totalHits += found;
        sb.append("  " + ze.getName() + " (KB: " + data.length / 1024 + ") hits: " + found + " of " + search + "\n");
      }
    }
    System.out.println("Inner APK entries: " + innerApkCount + " · total hits: " + totalHits + " for: " + search);
    System.out.print(sb);
  }
}
