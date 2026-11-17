import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const resolveClient = (rel) => (fs.existsSync(path.resolve(rel)) ? path.resolve(rel) : path.join(repoRoot, rel))

const supportCenterJsxPath = resolveClient('client/src/SupportCenter.jsx')
const supportCenterCssPath = resolveClient('client/src/SupportCenter.css')

test('FAQ Help Center Verification', async (t) => {
  const jsxContent = fs.readFileSync(supportCenterJsxPath, 'utf8')
  const cssContent = fs.readFileSync(supportCenterCssPath, 'utf8')

  await t.test('1. Preserves aiHustle branding and design cues', () => {
    assert.ok(jsxContent.includes('AIHUSTLE SUPPORT &amp; HELP CENTER') || jsxContent.includes('AIHUSTLE SUPPORT & HELP CENTER'), 'Hero includes aiHustle eyebrow')
    assert.ok(cssContent.includes('.faq-support-center-page'), 'Contains FAQ page container')
    assert.ok(cssContent.includes('--student-ink'), 'Uses existing design system CSS variables')
    assert.ok(cssContent.includes('--student-teal'), 'Uses teal accent')
  })

  await t.test('2. Header and Search functionality', () => {
    assert.ok(jsxContent.includes('How can we help you?'), 'Heading is "How can we help you?"')
    assert.ok(jsxContent.includes('Find answers to common questions and learn how to make the most of aiHustle.'), 'Subtitle matches requirement')
    assert.ok(jsxContent.includes('faq-search-input-box'), 'Prominent search input wrapper')
    assert.ok(jsxContent.includes('faq-search-clear-btn'), 'Clear search button is present')
    assert.ok(jsxContent.includes('faq-empty-state'), 'Empty state for no search matches is present')
  })

  await t.test('3. Organizes all 8 required FAQ categories', () => {
    const requiredCategories = [
      'Account and Registration',
      'Login and Security',
      'Courses and Learning',
      'Enrollments',
      'Assignments and Results',
      'Certificates',
      'Purchases and Payments',
      'Technical Issues',
    ]

    for (const cat of requiredCategories) {
      assert.ok(jsxContent.includes(`category: '${cat}'`), `Category "${cat}" must be defined`)
    }
  })

  await t.test('4. Includes all requested FAQ questions', () => {
    const requiredQuestions = [
      'How do I create an account?',
      'Can I change my username?',
      'How do I update my profile information?',
      'How do I sign in?',
      'Can I reset my password?',
      'How do I secure my account?',
      'Where do I find course content?',
      'How do I track my course progress?',
      'Can I resume a lesson where I left off?',
      'Can I watch videos again?',
      'How do I access course modules?',
      'How can I enroll in a course?',
      'Where can I find my enrolled courses?',
      'Where are my assignments and grades?',
      'How do I submit an assignment?',
      'Can I resubmit an assignment?',
      'How can I check my quiz scores?',
      'Where can I access certificates?',
      'When will I receive my certificate?',
      'How do I download my certificate?',
      'Where can I see purchases or invoices?',
      'How can I check my payment status?',
      'What should I do if my payment fails?',
      'How can I request a refund?',
      'What should I do if a video is not playing?',
      'What if a course page is not loading?',
      'Which browsers are supported?',
    ]

    for (const q of requiredQuestions) {
      assert.ok(jsxContent.includes(q), `Question "${q}" must be present in the FAQ knowledge base`)
    }
  })

  await t.test('5. Internal routes in answers point to real platform endpoints', () => {
    const validRoutes = [
      '/student/courses',
      '/student/assignments',
      '/student/results',
      '/student/certificates',
      '/student/profile',
      '/student/settings',
      '/student/learning-activity',
      '/student/achievements',
      '/student/purchases',
      '/student/help/submit-ticket',
      '/login',
      '/register',
    ]

    for (const route of validRoutes) {
      assert.ok(jsxContent.includes(`to="${route}"`) || jsxContent.includes(`to="${route}?`), `Route "${route}" should be linked in FAQ answers`)
    }
  })

  await t.test('6. Helpful feedback section ("Was this helpful?")', () => {
    assert.ok(jsxContent.includes('Was this helpful?'), 'Includes "Was this helpful?" prompt')
    assert.ok(jsxContent.includes('thumbsUp'), 'Includes Yes thumbs-up icon')
    assert.ok(jsxContent.includes('thumbsDown'), 'Includes No thumbs-down icon')
    assert.ok(jsxContent.includes('Feedback telemetry is not connected') || jsxContent.includes('telemetry is not connected'), 'Explains telemetry status honestly')
  })

  await t.test('7. Contact support card at bottom', () => {
    assert.ok(jsxContent.includes('Still need help?'), 'Card heading is "Still need help?"')
    assert.ok(
      jsxContent.includes("Can&rsquo;t find the answer you&rsquo;re looking for? Our support team is here to help.") ||
      jsxContent.includes("Can’t find the answer you’re looking for? Our support team is here to help.") ||
      jsxContent.includes("Can't find the answer you're looking for? Our support team is here to help."),
      'Card description is present'
    )
    assert.ok(jsxContent.includes('Contact Support'), 'Contains Contact Support action')
    assert.ok(jsxContent.includes('Report a Problem'), 'Contains Report a Problem action')
    assert.ok(jsxContent.includes('/student/help/submit-ticket'), 'Links to real ticket submission route')
  })

  await t.test('8. Full light and dark theme styling', () => {
    assert.ok(cssContent.includes('.faq-header-hero'), 'Hero styling present')
    assert.ok(cssContent.includes('.faq-accordion-item'), 'Accordion item styling present')
    assert.ok(cssContent.includes('.faq-accordion-item.is-open'), 'Open state styling present')
    assert.ok(cssContent.includes('.faq-support-card'), 'Support card styling present')
    assert.ok(cssContent.includes(":root[data-theme='dark'] .faq-header-hero"), 'Dark mode hero styling')
    assert.ok(cssContent.includes(":root[data-theme='dark'] .faq-accordion-item"), 'Dark mode accordion styling')
    assert.ok(cssContent.includes(":root[data-theme='dark'] .faq-support-card"), 'Dark mode support card styling')
    assert.ok(cssContent.includes('@media (max-width:'), 'Responsive media queries present')
  })
})
