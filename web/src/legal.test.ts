import {
  CONSENT_LEAD,
  CONSENT_USE,
  PRIVACY_AUDIO,
  TERMS_SERVICE,
} from './legalCopy'

if (/We do not keep the raw audio file/.test(PRIVACY_AUDIO)) {
  throw new Error('Privacy must not say raw audio is never kept; Keep recording stores WAV')
}

if (!/30 days/.test(PRIVACY_AUDIO)) {
  throw new Error('Privacy must say History / recordings are kept for 30 days')
}

if (/interview rehearsal/.test(TERMS_SERVICE)) {
  throw new Error('Terms must not lead with interview rehearsal')
}

if (/hidden prompt in a live interview/.test(CONSENT_USE)) {
  throw new Error('Consent must not position Nodpilot as a live-interview cheat')
}

if (/coming soon/.test(CONSENT_LEAD)) {
  throw new Error('Consent must not advertise Windows desktop as part of this test')
}
