import '../../shared/base.css'
import './hunt.css'
import sceneHtml from './scene.html'
import {startTreasureHunt} from './game.js'

document.getElementById('ar-root').innerHTML = sceneHtml
startTreasureHunt()
