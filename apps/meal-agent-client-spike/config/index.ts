import { defineConfig, type UserConfigExport } from '@tarojs/cli'

export default defineConfig<'webpack5'>(async (merge, { command }) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'meal-agent-client-spike',
    date: '2026-07-23',
    designWidth: 750,
    deviceRatio: {
      375: 2,
      640: 2.34 / 2,
      750: 1,
      828: 1.81 / 2
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    framework: 'react',
    compiler: 'webpack5',
    defineConstants: {
      __MEAL_AGENT_MOCK_API_BASE_URL__: JSON.stringify(
        process.env.MEAL_AGENT_MOCK_API_BASE_URL ?? 'http://127.0.0.1:8787'
      )
    },
    cache: {
      enable: false
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {}
        },
        cssModules: {
          enable: false,
          config: {
            namingPattern: 'module',
            generateScopedName: '[name]__[local]___[hash:base64:5]'
          }
        }
      }
    }
  }

  return command === 'build'
    ? merge({}, baseConfig, { mini: { debugReact: false } })
    : baseConfig
})
