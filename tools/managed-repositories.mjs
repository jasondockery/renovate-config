import fs from 'node:fs'
import path from 'node:path'

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u

export function loadManagedRepositories(root) {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'managed-repositories.json'), 'utf8'))
  const repositories = value?.repositories
  const retired = value?.retiredRepositories
  if (value?.schemaVersion !== 1 || !Array.isArray(repositories) ||
      repositories.length === 0 || repositories.length > 16 ||
      !Array.isArray(retired) || retired.length > 32 ||
      [...repositories, ...retired].some((slug) => typeof slug !== 'string' || !SLUG.test(slug)) ||
      new Set(repositories).size !== repositories.length || new Set(retired).size !== retired.length ||
      new Set(repositories.map((slug) => slug.split('/')[0])).size !== 1) {
    throw new Error('managed-repositories.json must declare 1–16 unique same-owner repositories and a valid retirement list')
  }
  if (repositories.some((slug) => retired.includes(slug))) {
    throw new Error('a retired repository cannot receive dependency updates')
  }
  return Object.freeze([...repositories])
}
