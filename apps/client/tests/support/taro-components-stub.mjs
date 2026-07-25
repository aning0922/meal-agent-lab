import { createElement, forwardRef } from 'react'

const component = (displayName, hostName) => {
  const Component = forwardRef(({ children, ...props }, ref) =>
    createElement(hostName, { ...props, ref }, children)
  )
  Component.displayName = displayName
  return Component
}

export const Button = component('Button', 'taro-button')
export const Input = component('Input', 'taro-input')
export const Text = component('Text', 'taro-text')
export const View = component('View', 'taro-view')
