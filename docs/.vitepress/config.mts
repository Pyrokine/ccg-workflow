import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/ccg-workflow/',
  lang: 'zh-CN',
  title: 'CCG',
  description: 'CCG 的安装、更新与使用说明',
  themeConfig: {
    nav: [
      { text: '使用说明', link: '/' },
      { text: 'GitHub', link: 'https://github.com/Pyrokine/ccg-workflow' },
    ],
  },
})
