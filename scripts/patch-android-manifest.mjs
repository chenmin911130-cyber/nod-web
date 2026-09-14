import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifestPath = resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml')
if (!existsSync(manifestPath)) {
  process.stderr.write('patch-android-manifest: android project missing — run npx cap add android\n')
  process.exit(1)
}

let xml = readFileSync(manifestPath, 'utf8')

function ensurePermission(name) {
  const tag = `<uses-permission android:name="${name}" />`
  if (xml.includes(`android:name="${name}"`)) return
  if (xml.includes('<!-- Permissions -->')) {
    xml = xml.replace('<!-- Permissions -->', `<!-- Permissions -->\n\n    ${tag}`)
    return
  }
  xml = xml.replace('<application', `    ${tag}\n    <application`)
}

ensurePermission('android.permission.INTERNET')
ensurePermission('android.permission.RECORD_AUDIO')
ensurePermission('android.permission.MODIFY_AUDIO_SETTINGS')

const intent = `            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="nodpilot" />
            </intent-filter>`

if (!xml.includes('android:scheme="nodpilot"')) {
  xml = xml.replace(
    '</activity>',
    `${intent}\n        </activity>`,
  )
}

writeFileSync(manifestPath, xml)
process.stdout.write('patch-android-manifest: RECORD_AUDIO, INTERNET, nodpilot://\n')
