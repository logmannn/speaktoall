// Converts microphone audio to 16 kHz mono PCM16 in ~100 ms frames for Deepgram.
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.position = 0;
    this.previous = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.length = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear-interpolation resampling; position carries across render quanta,
    // where -1 refers to the previous quantum's last sample.
    while (this.position <= input.length - 1) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const a = index < 0 ? this.previous : input[index];
      const b = input[index + 1] ?? a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.frame[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.sumSquares += sample * sample;
      if (this.length === FRAME_SAMPLES) this.flush();
      this.position += this.step;
    }
    this.position -= input.length;
    this.previous = input[input.length - 1];
    return true;
  }

  flush() {
    const pcm = this.frame.slice(0, this.length).buffer;
    const level = Math.sqrt(this.sumSquares / this.length);
    this.port.postMessage({ pcm, level }, [pcm]);
    this.length = 0;
    this.sumSquares = 0;
  }
}

registerProcessor("pcm-capture", PcmCapture);
