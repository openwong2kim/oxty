// Page for renderer.test.mjs: the tests drive panes through `window.T` with page.evaluate.
import { TextureAtlas } from '../../vendor-xterm/addons/addon-webgl/src/TextureAtlas';
import { Pane, diff, ready, sleep } from './renderer-pane';

// Atlases disposed so far, to check the atlas cache lets go of them
const disposedAtlases = new Set<TextureAtlas>();
const dispose = TextureAtlas.prototype.dispose;
TextureAtlas.prototype.dispose = function (this: TextureAtlas) {
  disposedAtlases.add(this);
  dispose.call(this);
};

Object.assign(window, { T: { Pane, diff, sleep, disposedAtlases } });
ready.then(() => Object.assign(window, { ready: true }));
