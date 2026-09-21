require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'NodMic'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.homepage = 'https://nodpilot.com'
  s.author = 'Nod'
  s.source = { :git => 'https://github.com/chenm/nod-web.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/NodMicPlugin/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.resources = ['ios/Sources/NodMicPlugin/PrivacyInfo.xcprivacy']
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
