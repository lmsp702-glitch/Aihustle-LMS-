import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

test('Theme Toggle & Dark Mode Integration Suite', async (t) => {
  const themeToggleCode = fs.readFileSync(path.resolve('client/src/ThemeToggle.jsx'), 'utf-8')
  const studentDashboardCode = fs.readFileSync(path.resolve('client/src/StudentDashboard.jsx'), 'utf-8')
  const appCode = fs.readFileSync(path.resolve('client/src/App.jsx'), 'utf-8')
  const indexHtmlCode = fs.readFileSync(path.resolve('client/index.html'), 'utf-8')
  const indexCssCode = fs.readFileSync(path.resolve('client/src/index.css'), 'utf-8')
  const studentDashboardCssCode = fs.readFileSync(path.resolve('client/src/StudentDashboard.css'), 'utf-8')

  await t.test('1. ThemeToggle supports both onToggle and onToggleTheme props', () => {
    assert.match(
      themeToggleCode,
      /onToggleTheme/,
      'ThemeToggle must accept onToggleTheme prop for compatibility with StudentDashboard',
    )
    assert.match(
      themeToggleCode,
      /onToggle\s*\|\|\s*onToggleTheme\s*\|\|\s*onClick/,
      'ThemeToggle must resolve handleToggle from onToggle, onToggleTheme, or onClick',
    )
  })

  await t.test('2. ThemeToggle renders moon icon for light mode and sun icon for dark mode with accessible labels', () => {
    // Accessible aria labels and titles for both states
    assert.match(themeToggleCode, /Switch to light mode/i)
    assert.match(themeToggleCode, /Switch to dark mode/i)
    assert.match(themeToggleCode, /aria-pressed=\{Boolean\(isDark\)\}/)

    // Sun icon circle and rays path in dark state
    assert.match(themeToggleCode, /circle cx="10" cy="10" r="3\.5"/)
    assert.match(themeToggleCode, /M10 1\.8v2/)

    // Moon icon crescent path in light state
    assert.match(themeToggleCode, /M16\.8 12\.2A7\.3 7\.3 0 0 1 7\.8 3\.2/)
  })

  await t.test('3. StudentDashboard connects theme toggling to ThemeToggle component', () => {
    // Accepts isDark, onToggleTheme, themePreference, onSetTheme
    assert.match(studentDashboardCode, /isDark\s*=\s*false/)
    assert.match(studentDashboardCode, /onToggleTheme/)
    assert.match(studentDashboardCode, /handleToggleTheme/)

    // ThemeToggle receives onToggle and onToggleTheme
    assert.match(studentDashboardCode, /<ThemeToggle\s+isDark=\{isDark\}\s+onToggle=\{handleToggleTheme\}\s+onToggleTheme=\{handleToggleTheme\}/)

    // Root student-dashboard has data-theme attribute
    assert.match(studentDashboardCode, /data-theme=\{isDark \? 'dark' : 'light'\}/)
  })

  await t.test('4. App.jsx persists theme in localStorage and updates root documentElement dataset', () => {
    // Reads lms.theme on mount
    assert.match(appCode, /localStorage\.getItem\(['"]lms\.theme['"]\)/)

    // Updates document.documentElement.dataset.theme
    assert.match(appCode, /document\.documentElement\.dataset\.theme\s*=\s*isDark \? 'dark' : 'light'/)

    // Persists lms.theme to localStorage
    assert.match(appCode, /localStorage\.setItem\(['"]lms\.theme['"],\s*themePreference\)/)

    // Synchronizes storage events across tabs
    assert.match(appCode, /addEventListener\(['"]storage['"]/)

    // Passes theme props to DashboardPage / StudentDashboard
    assert.match(appCode, /onToggleTheme=\{toggleTheme\}/)
    assert.match(appCode, /themePreference=\{themePreference\}/)
    assert.match(appCode, /onSetTheme=\{setThemePreference\}/)
  })

  await t.test('5. index.html contains inline theme bootstrapper to eliminate flash of light theme on refresh', () => {
    assert.match(indexHtmlCode, /localStorage\.getItem\(['"]lms\.theme['"]\)/)
    assert.match(indexHtmlCode, /document\.documentElement\.dataset\.theme\s*=\s*['"]dark['"]/)
  })

  await t.test('6. CSS files define complete dark theme variables for Student Dashboard', () => {
    // index.css
    assert.match(indexCssCode, /:root\[data-theme='dark'\] \.student-dashboard/)
    assert.match(indexCssCode, /--student-ink:\s*var\(--theme-ink\)/)
    assert.match(indexCssCode, /--student-paper:\s*var\(--theme-surface\)/)
    assert.match(indexCssCode, /--student-canvas:\s*var\(--theme-canvas\)/)

    // StudentDashboard.css
    assert.match(studentDashboardCssCode, /:root\[data-theme='dark'\] \.student-dashboard/)
    assert.match(studentDashboardCssCode, /\.student-dashboard\.is-dark/)
    assert.match(studentDashboardCssCode, /\.student-dashboard\[data-theme='dark'\]/)
  })
})
