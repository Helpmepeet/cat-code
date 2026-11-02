import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { welcomeCatPoses, welcomeCatActions } from './welcomeCatCollections.js'

test('original mascot poses and generated action scenes cover separate asset families', () => {
  const families = [
    { images: welcomeCatPoses, folder: 'mascot-100', sourceExtension: '.png', displayExtension: '.png' },
    { images: welcomeCatActions, folder: 'generated-welcome-cats', sourceExtension: '.png', displayExtension: '.webp' },
  ]

  for (const { images, folder, sourceExtension, displayExtension } of families) {
    const sources = readdirSync(new URL(`./assets/${folder}/`, import.meta.url))
      .filter(name => name.endsWith(sourceExtension))
      .map(name => basename(name, sourceExtension))
      .sort()
    expect(images.map(image => basename(image, displayExtension)).sort()).toEqual(sources)
    expect(images.every(image => image.includes(`/assets/${folder}/`))).toBe(true)
  }

  expect(new Set([...welcomeCatPoses, ...welcomeCatActions]).size)
    .toBe(welcomeCatPoses.length + welcomeCatActions.length)
})
