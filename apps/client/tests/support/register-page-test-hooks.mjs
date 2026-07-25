import { registerHooks } from 'node:module'

const componentsStubUrl = new URL(
  './taro-components-stub.mjs',
  import.meta.url
).href
const taroStubUrl = new URL('./taro-runtime-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@tarojs/components') {
      return { url: componentsStubUrl, shortCircuit: true }
    }
    if (specifier === '@tarojs/taro') {
      return { url: taroStubUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
