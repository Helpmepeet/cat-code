import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../../src/utils/model/model.js'
import { getSupportedEffortLevels, modelSupportsEffort } from '../../src/utils/effort.js'

type EffortReaders = {
  getDefaultMainLoopModel: () => string
  parseUserSpecifiedModel: (value: string) => string
  modelSupportsEffort: (model: string) => boolean
  getSupportedEffortLevels: (model: string) => readonly string[]
}
const engineReaders: EffortReaders = {
  getDefaultMainLoopModel, parseUserSpecifiedModel, modelSupportsEffort, getSupportedEffortLevels,
}

/**
 * Picker rows hold selections (aliases or null for Default), not resolved model
 * ids. Resolve through the engine before capability lookup: effort helpers do
 * not recognize unresolved aliases. Failed engine reads degrade only this row.
 */
export function effortOptionsForSelection(value: string | null, readers: EffortReaders = engineReaders): string[] {
  try {
    const model = value == null ? readers.getDefaultMainLoopModel() : readers.parseUserSpecifiedModel(value)
    if (!model) return []
    return readers.modelSupportsEffort(model) ? [...readers.getSupportedEffortLevels(model)] : []
  } catch {
    return []
  }
}
