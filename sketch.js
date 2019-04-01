const SERVER_IP = '127.0.0.1'
const SERVER_PORT = 5000
const SAMPLE_RATE = 200 // ~200 Hz sampling rate
/*
 1 second windows b/c max brainwave frequency we care about is 100 Hz.
 FFT library requires power-of-two buffer size, and will compute frequencies
 up to half the buffer size (128 Hz)
 */
// const WINDOW_SIZE = SAMPLE_RATE
const WINDOW_SIZE = 256
const LOWEST_FADER_SETTING = -12 // Decibels


// Also bind to a UDP socket.
const udpPort = new osc.UDPPort({
    localAddress: SERVER_IP,
    localPort: SERVER_PORT
});
udpPort.on("ready", () => console.log("Listening on UDP port 5000."));
udpPort.on("error", (err) => {
    console.log("UDP PORT ERROR:");
    console.log(err);
});

// linearly maps value from the range (a..b) to (c..d)
function mapRange (value, a, b, c, d) {
    // first map value from (a..b) to (0..1)
    value = (value - a) / (b - a);
    // then map it from (0..1) to (c..d) and return it
    return c + value * (d - c);
}

function doFFT(buffer) {
  let fft = new FFT(WINDOW_SIZE, SAMPLE_RATE);
  fft.forward(buffer);
  // console.log(fft.spectrum);
  return fft.spectrum;
}

function getEEGBands(spectrum) {
  return [ // Note: spectrum starts at 1Hz, but indexes from 0
    spectrum.slice(1, 4), // Delta: 2-4 Hz (1 Hz gets too much signal, ignoring as bad data)
    spectrum.slice(4, 7), // Theta: 5-7 Hz
    spectrum.slice(7, 12), // Alpha: 8-12 Hz
    spectrum.slice(12, 30), // Beta: 13-30 Hz
    spectrum.slice(30, 100) // Gamma: 31-100 Hz
  ]
}

function getRelativeEnergies(eegBands) {
  const sums = eegBands.map((band) =>
    band.reduce((total, next) => total + next)
  );
  const totalEnergy = sums.reduce((total, next) => total + next);
  // For now, not normalizing by band size. Maybe will try later.
  const totalLength = eegBands.reduce(
    (total, band) => (total + band.length),
    0
  );
  const relativeWidths = eegBands.map((band) => band.length / totalLength);
  return eegBands.map((band, i) => sums[i] / totalEnergy * relativeWidths[i]);

  return eegBands.map((band, i) => sums[i] / totalEnergy);
}

function getWeightedAvgFrequencies(eegBands) {
  function getWeightedAvgFrequency(band, lowestFreq) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < band.length; i++) {
      const freq = lowestFreq + i;
      sum += freq * band[i];
      n += band[i];
    }
    return sum / n;
  }
  return [
    getWeightedAvgFrequency(eegBands[0], 2), // Recall that we skip 1Hz
    getWeightedAvgFrequency(eegBands[1], 5),
    getWeightedAvgFrequency(eegBands[2], 8),
    getWeightedAvgFrequency(eegBands[3], 13),
    getWeightedAvgFrequency(eegBands[4], 31)
  ]
}
let sines = [];
let faders = [];
for (let i = 0; i < 5; i++) {
  const sine = new Tone.Oscillator(new Tone.Frequency("A"+(1+i)), 'sawtooth');
// for (let i = 1; i <= 100; i++) {
  // const sine = new Tone.Oscillator(new Tone.Frequency(i));
  // const fm = new Tone.Noise('pink');
  // fm.connect(sine.detune);
  sines.push(sine);
  const fader = new Tone.Volume();
  faders.push(fader);
  sine.chain(fader, Tone.Master);
  sine.start();
}

function handleBand(i, lowestEEGFreq, highestEEGFreq, relativeEnergy, weightedAvgFreq) {
  const octave = i+1; // octaves from A1-A6 (A1..A2 for Delta band, up to A5..A6 for Gamma)
  const lowestSoundFreq = new Tone.Frequency("A"+octave).toFrequency();
  const highestSoundFreq = new Tone.Frequency("A"+(octave+1)).toFrequency();
  const freq = mapRange(weightedAvgFreq, lowestEEGFreq, highestEEGFreq, lowestSoundFreq, highestSoundFreq);
  const fade = mapRange(relativeEnergy, 1, 0, 0, LOWEST_FADER_SETTING);
  sines[i].frequency.linearRampTo(freq, 1);
  faders[i].volume.linearRampTo(fade, 1);
}

const buffers = [
  new Float64Array(WINDOW_SIZE),
  new Float64Array(WINDOW_SIZE),
  new Float64Array(WINDOW_SIZE),
  new Float64Array(WINDOW_SIZE)
]
let windowIndex = 0;

udpPort.on("message", (msg) => {
  // console.log(msg);
  if (msg.address !== "/eeg") return;
  // console.log(`${msg.address}: ${msg.args}`);

  for (let i = 0; i < 4; i++) {
    buffers[i][windowIndex] = msg.args[i];
  }
  windowIndex++;

  if (windowIndex >= WINDOW_SIZE) {
    const i = 0;
    // for (let i = 0; i < 4; i++) {

      const eegBands = getEEGBands(doFFT(buffers[i]));
      const relativeEnergies = getRelativeEnergies(eegBands);
      const weightedAvgFrequencies = getWeightedAvgFrequencies(eegBands)
      // console.log(eegBands);
      console.log(relativeEnergies);
      console.log(weightedAvgFrequencies);

      handleBand(0, 2, 4, relativeEnergies[0], weightedAvgFrequencies[0]);
      handleBand(1, 5, 7, relativeEnergies[1], weightedAvgFrequencies[1]);
      handleBand(2, 8, 12, relativeEnergies[2], weightedAvgFrequencies[2]);
      handleBand(3, 13, 30, relativeEnergies[3], weightedAvgFrequencies[3]);
      handleBand(4, 31, 100, relativeEnergies[4], weightedAvgFrequencies[4]);

/*
      // Additive synthesis (time -> domain -> time)
      const spectrum = doFFT(buffers[i]).slice(1); // Ignore 1 Hz (index 0)
      console.log(spectrum);
      const totalEnergy = spectrum.reduce((total, energy) => total + energy);
      const normalizedEnergies = spectrum.map((energy) => energy / totalEnergy);
      for (let freq = 1; freq <= 100; freq++) {
        const normalizedEnergy = normalizedEnergies[freq-1];
        const fade = mapRange(normalizedEnergy, 1, 0, 0, LOWEST_FADER_SETTING);
        faders[freq-1].volume.linearRampTo(fade, 1);
      }
*/

      buffers[i] = new Float64Array(WINDOW_SIZE);
    // }
    windowIndex = 0;
  }
});

udpPort.open();