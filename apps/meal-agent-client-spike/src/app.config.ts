export default defineAppConfig({
  pages: [
    'pages/today/index',
    'pages/inventory/index'
  ],
  tabBar: {
    color: '#6d746f',
    selectedColor: '#186a4b',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      {
        pagePath: 'pages/today/index',
        text: '今天'
      },
      {
        pagePath: 'pages/inventory/index',
        text: '库存'
      }
    ]
  },
  window: {
    backgroundColor: '#f4f6f1',
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#f4f6f1',
    navigationBarTextStyle: 'black',
    navigationBarTitleText: 'Meal Agent 技术实验'
  }
})
