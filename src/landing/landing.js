import './landing.css'
import {experiences, landingExperienceIds, routeOf} from '../../experiences.config.js'

/** Build one card's HTML from an experience descriptor. */
function card(exp) {
  const badge = exp.badge ? `<span class="badge">${exp.badge}</span>` : ''
  const featuredClass = exp.featured ? ' card--featured' : ''
  return `
    <a class="card${featuredClass}" href="/${routeOf(exp)}/" style="--accent:${exp.accent}">
      <span class="card-icon">${exp.icon || '✨'}</span>
      <span class="card-body">
        <span class="card-title">${exp.title}${badge}</span>
        <span class="card-desc">${exp.description || ''}</span>
      </span>
      <span class="card-arrow" aria-hidden="true">›</span>
    </a>`
}

function render(targetId, items) {
  const el = document.getElementById(targetId)
  if (el) el.innerHTML = items.map(card).join('')
}

const visibleIds = Array.isArray(landingExperienceIds)
  ? new Set(landingExperienceIds)
  : null
const landingExperiences = visibleIds
  ? experiences.filter((experience) => visibleIds.has(experience.id))
  : experiences

render('samples', landingExperiences.filter((e) => e.category === 'sample'))
render('games', landingExperiences.filter((e) => e.category === 'game'))
