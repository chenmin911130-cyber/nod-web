import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const plistPath = resolve(process.cwd(), 'ios/App/App/Info.plist')
if (!existsSync(plistPath)) {
  process.stderr.write('patch-ios-plist: ios/App/App/Info.plist not found — run npx cap add ios on a machine with the iOS template.\n')
  process.exit(0)
}

let xml = readFileSync(plistPath, 'utf8')
const replacements = [
  [
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]*<\/string>/,
    '<key>NSMicrophoneUsageDescription</key>\n\t<string>Nod uses the microphone to transcribe meetings, lectures, and interviews. Recording continues while the screen is locked if you already started listening.</string>',
  ],
]

if (!xml.includes('NSMicrophoneUsageDescription')) {
  xml = xml.replace(
    '</dict>\n</plist>',
    '\t<key>NSMicrophoneUsageDescription</key>\n\t<string>Nod uses the microphone to transcribe meetings, lectures, and interviews. Recording continues while the screen is locked if you already started listening.</string>\n</dict>\n</plist>',
  )
} else {
  xml = xml.replace(replacements[0][0], replacements[0][1])
}

if (!xml.includes('UIBackgroundModes')) {
  xml = xml.replace(
    '</dict>\n</plist>',
    '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>\n</plist>',
  )
} else if (!xml.includes('<string>audio</string>')) {
  xml = xml.replace(
    /<key>UIBackgroundModes<\/key>\s*<array>/,
    '<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>',
  )
}

if (!xml.includes('ITSAppUsesNonExemptEncryption')) {
  xml = xml.replace(
    '</dict>\n</plist>',
    '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n</dict>\n</plist>',
  )
}

if (!xml.includes('nodpilot')) {
  xml = xml.replace(
    '</dict>\n</plist>',
    '\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>com.nodpilot.app</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>nodpilot</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>',
  )
}

writeFileSync(plistPath, xml)
process.stdout.write('patch-ios-plist: microphone, background audio, nodpilot:// scheme\n')
