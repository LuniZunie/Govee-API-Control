import { util } from './utility.mjs';
const digits = 6;

const getNumberString = number => number.toString().padStart(digits, '0'),
      getNumberText = () => document.querySelector('#number-text'),
      getDigits = () => document.querySelectorAll('#number-text > .digit'),
      getTrack = i => document.querySelector(`#number-text > .digit:nth-child(${i + 1}) > .digit-track`);

function createTrackHalf(track, trackHalf) {
  for (let i = 0; i < 10; i++) {
    const number = util.createElement('div', [ trackHalf, 'character', `number-${i}` ], i);
    if (trackHalf === 'upper' && i === 0) number.classList.add('active');

    track.appendChild(number);
  }
};

function init() {
  for (let i = 0; i < digits; i++) {
    const digit = util.createElement('div', 'digit'),
          track = util.createElement('div', 'digit-track');

    digit.appendChild(track);
    createTrackHalf(track, 'upper'); createTrackHalf(track, 'lower');

    getNumberText().appendChild(digit);
    digit.style.height = track.querySelector('.character').offsetHeight + 'px';
  }
}
init();

function DisplayNumber(number, direction = 'auto') {
  if (direction === 'auto') {
    const current = getNumberString(+[ ...getDigits() ].map(digit => digit.querySelector('.active').innerText).join(''));
    direction = number > current ? 'increase' : 'decrease';
  }

  number = getNumberString(Math.max(+number | 0, 0));
  for (let i = 0; i < digits; i++) {
    const track = getTrack(i), n = +number[i];

    const active = track.querySelector('.character.active'), nPrev = +active.innerText;
    if (nPrev === n) continue;
    else active.classList.remove('active');

    track.style.transitionDuration = '0ms';
    let target;
    if (direction === 'increase') {
      if (n < nPrev) target = `.lower.number-${n}`;
      else target = `.upper.number-${n}`;

      track.style.transform = `translateY(-${active.offsetHeight * nPrev}px)`;
    } else {
      if (n > nPrev) target = `.upper.number-${n}`;
      else target = `.lower.number-${n}`;

      track.style.transform = `translateY(-${active.offsetHeight * (nPrev + 10)}px)`;
    }
    track.offsetHeight;
    track.style.transitionDuration = '';

    const character = track.querySelector(target); character.classList.add('active');
    track.style.transform = `translateY(-${character.offsetHeight * (n + 10 * target.startsWith('.lower'))}px)`;
  }
}

export default DisplayNumber;