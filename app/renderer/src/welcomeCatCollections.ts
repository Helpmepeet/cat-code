import catBase from './assets/mascot-100/base.png'
import catCoding from './assets/mascot-100/coding.png'
import sleepingCat from './assets/mascot-100/sleeping.png'
import catStretching from './assets/mascot-100/stretching.png'
import catThinking from './assets/mascot-100/thinking.png'
import catWaving from './assets/mascot-100/waving.png'

export const welcomeCatPoses: readonly string[] = [
  catBase,
  sleepingCat,
  catCoding,
  catStretching,
  catThinking,
  catWaving,
]

export { generatedWelcomeCats as welcomeCatActions } from './generatedWelcomeCats.js'
