// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§69]

/**
 * Browser-side audio hooks for NotebookLM.
 *
 * NotebookLM's Audio Overview plays through <audio> elements and the Web Audio API —
 * NOT WebRTC like X Spaces. This module hooks HTMLMediaElement and AudioContext
 * to capture podcast audio and expose getUserMedia override for mic injection.
 *
 * Injected into the NotebookLM page via page.evaluateOnNewDocument().
 */

export const notebookLMAudioHooksCode = /* javascript */ `
(function() {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────

  let captureCtx = null;
  let injectionCtx = null;
  let injectionWorkletNode = null;
  let injectionDestNode = null;
  let controlledMicStream = null;
  const capturedMediaElements = new WeakSet();

  // ── Logging ──────────────────────────────────────────────────────────────

  function log(msg) {
    if (typeof window.__nlmLog === 'function') {
      window.__nlmLog('[NLM-Audio] ' + msg);
    }
  }

  // ── Capture: hook HTMLMediaElement ───────────────────────────────────────
  // NotebookLM plays the podcast via <audio src="blob:...">

  const CAPTURE_SAMPLE_RATE = 16000; // 16kHz for STT pipeline compatibility
  const CHUNK_INTERVAL_MS = 100;     // emit PCM chunks every 100ms

  async function captureMediaElement(el) {
    if (capturedMediaElements.has(el)) return;
    capturedMediaElements.add(el);
    log('Hooking audio element: ' + (el.src || el.currentSrc || 'unknown'));

    try {
      if (!captureCtx) {
        captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      }
      if (captureCtx.state === 'suspended') {
        await captureCtx.resume();
      }

      const source = captureCtx.createMediaElementSource(el);
      // Re-connect to destination so audio still plays through speakers
      source.connect(captureCtx.destination);

      // ScriptProcessor for broad compatibility (worklet would require blob URL)
      const bufferSize = Math.floor(CAPTURE_SAMPLE_RATE * CHUNK_INTERVAL_MS / 1000);
      const processor = captureCtx.createScriptProcessor(4096, 1, 1);

      let chunkCount = 0;
      processor.onaudioprocess = function(e) {
        const pcm = e.inputBuffer.getChannelData(0);
        // Skip silent frames
        let maxAbs = 0;
        for (let i = 0; i < pcm.length; i++) {
          const abs = Math.abs(pcm[i]);
          if (abs > maxAbs) maxAbs = abs;
        }
        if (maxAbs < 0.0005) return;

        const bytes = new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
        let binary = '';
        const step = 8192;
        for (let i = 0; i < bytes.length; i += step) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
        }
        const b64 = btoa(binary);

        if (typeof window.__onNLMAudio === 'function') {
          window.__onNLMAudio(b64, CAPTURE_SAMPLE_RATE);
        }
        chunkCount++;
        if (chunkCount % 100 === 0) log('Captured ' + chunkCount + ' podcast audio chunks');
      };

      source.connect(processor);
      processor.connect(captureCtx.destination);
      log('Audio element capture active');
    } catch (err) {
      log('captureMediaElement error: ' + err.message);
    }
  }

  // Intercept HTMLMediaElement.play() to hook any <audio> element when it starts playing
  const _origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (this.tagName === 'AUDIO' || (this.tagName === 'VIDEO' && this.muted)) {
      captureMediaElement(this).catch(function(err) { log('capture hook error: ' + err.message); });
    }
    return _origPlay.apply(this, arguments);
  };

  // Also watch for dynamically added <audio> elements
  const audioObserver = new MutationObserver(function(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          const audios = node.tagName === 'AUDIO' ? [node] : Array.from(node.querySelectorAll('audio'));
          for (const audio of audios) {
            if (!audio.paused && !capturedMediaElements.has(audio)) {
              captureMediaElement(audio).catch(function(err) { log('observer hook error: ' + err.message); });
            }
          }
        }
      }
    }
  });
  audioObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ── Injection: getUserMedia override for mic input ────────────────────────
  // NotebookLM interactive mode requests microphone via getUserMedia.
  // We intercept it and return a controlled MediaStream that we feed
  // PCM data into (X Space participant speech → NotebookLM hosts).

  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  async function getInjectionStream() {
    if (controlledMicStream) return controlledMicStream;

    injectionCtx = new AudioContext({ sampleRate: 48000 });
    injectionDestNode = injectionCtx.createMediaStreamDestination();

    // Simple ScriptProcessor injection — pushes Float32 chunks from the queue
    const processor = injectionCtx.createScriptProcessor(4096, 1, 1);
    const queue = [];
    let queuePos = 0;

    processor.onaudioprocess = function(e) {
      const out = e.outputBuffer.getChannelData(0);
      let outPos = 0;
      while (outPos < out.length && queue.length > 0) {
        const chunk = queue[0];
        const remaining = chunk.length - queuePos;
        const toCopy = Math.min(remaining, out.length - outPos);
        out.set(chunk.subarray(queuePos, queuePos + toCopy), outPos);
        outPos += toCopy;
        queuePos += toCopy;
        if (queuePos >= chunk.length) {
          queue.shift();
          queuePos = 0;
        }
      }
      // Silence padding
      for (; outPos < out.length; outPos++) out[outPos] = 0;
    };

    processor.connect(injectionDestNode);
    injectionCtx.createGain().connect(processor); // keep processor alive

    // Expose queue injection API
    window.__nlmInjectPCM = function(pcmFloat32Base64) {
      try {
        const raw = atob(pcmFloat32Base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const float32 = new Float32Array(bytes.buffer);
        queue.push(float32);
        if (queue.length > 50) queue.splice(0, queue.length - 50); // prevent unbounded growth
      } catch (err) {
        log('PCM inject error: ' + err.message);
      }
    };

    controlledMicStream = injectionDestNode.stream;
    log('Controlled mic stream created for NotebookLM interactive mode');
    return controlledMicStream;
  }

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (constraints && constraints.audio) {
      log('getUserMedia intercepted — returning controlled mic stream');
      return getInjectionStream();
    }
    return _origGetUserMedia(constraints);
  };

  // ── Playback state detection ─────────────────────────────────────────────

  window.__nlmGetPlaybackState = function() {
    const audios = Array.from(document.querySelectorAll('audio'));
    if (audios.length === 0) return { playing: false, duration: 0, currentTime: 0 };
    const active = audios.find(function(a) { return !a.paused; }) || audios[0];
    return {
      playing: !active.paused,
      duration: active.duration || 0,
      currentTime: active.currentTime || 0,
      ended: active.ended,
    };
  };

  // ── Dispose ──────────────────────────────────────────────────────────────

  window.__nlmDispose = function() {
    audioObserver.disconnect();
    if (captureCtx) { captureCtx.close().catch(function(){}); captureCtx = null; }
    if (injectionCtx) { injectionCtx.close().catch(function(){}); injectionCtx = null; }
    controlledMicStream = null;
    log('NotebookLM audio hooks disposed');
  };

  log('NotebookLM audio hooks installed');
})();
`
