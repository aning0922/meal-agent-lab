const unsupported = () => {
  throw new Error('Taro runtime stub must not be called in page rendering tests')
}

export default {
  getStorageSync: unsupported,
  login: unsupported,
  navigateBack: unsupported,
  navigateTo: unsupported,
  reLaunch: unsupported,
  removeStorageSync: unsupported,
  request: unsupported,
  setStorageSync: unsupported
}
