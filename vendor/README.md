# WeChat browser asset

jweixin-1.6.0.js is the unmodified official browser SDK retrieved from
https://res.wx.qq.com/open/js/jweixin-1.6.0.js and retained for deterministic,
same-origin platform delivery. It is a third-party WeChat asset; original rights
remain with its provider. The Tiana build embeds its unchanged bytes inside a private SDK factory in dist/jweixin.js; the delivery wrapper preserves existing global aliases and owns/removes document listeners. It is not
executed or downloaded by applications until location is requested in mobile
WeChat. No platform identity, credential or signing ticket is embedded in it.
