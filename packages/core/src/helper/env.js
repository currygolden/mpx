const env = {}
env.wx = typeof wx !== 'undefined' && typeof wx.canIUse === 'function'
env.ali = typeof my !== 'undefined' && typeof my.canIUse === 'function'
export function is (type) {
  return !!env[type]
}
