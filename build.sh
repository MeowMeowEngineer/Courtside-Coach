#!/usr/bin/env bash
# Builds a signed APK from web/ + android/ without Gradle.
# Needs: JDK 17+, and Ubuntu packages android-sdk-platform-23 aapt apksigner zipalign android-sdk-build-tools.
set -euo pipefail
cd "$(dirname "$0")"

SDK=${ANDROID_SDK:-/usr/lib/android-sdk}
BT=$SDK/build-tools/29.0.3
JAR=$SDK/platforms/android-23/android.jar
VERSION_CODE=${VERSION_CODE:-2}
VERSION_NAME=${VERSION_NAME:-0.1.1}
OUT=dist/CourtsideCoach-$VERSION_NAME.apk
KS=android/courtside.keystore

rm -rf build && mkdir -p build/assets/www build/classes build/dex dist
cp -r web/. build/assets/www/

aapt2 compile --dir android/res -o build/res.zip
aapt2 link -o build/unsigned.apk -I "$JAR" \
  --manifest android/AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -0 wasm -0 task \
  -A build/assets build/res.zip

javac -nowarn -source 8 -target 8 -bootclasspath "$JAR" -d build/classes \
  $(find android/src -name '*.java') 2>build/javac.log || { cat build/javac.log; exit 1; }
java -jar "$BT/lib/dx.jar" --dex --min-sdk-version=26 --output=build/dex/classes.dex build/classes
(cd build/dex && zip -q ../unsigned.apk classes.dex)

zipalign -p -f 4 build/unsigned.apk build/aligned.apk

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass courtside -keypass courtside -alias courtside \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Courtside Coach" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-pass pass:courtside --ks-key-alias courtside --out "$OUT" build/aligned.apk
apksigner verify --print-certs "$OUT" | head -3
ls -la "$OUT"
