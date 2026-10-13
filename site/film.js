// The films. Each "Watch" button opens its <dialog> and plays the video in it. Nothing is
// downloaded before that: the videos are preload="none" and the poster is set on opening.
// Closing the dialog (the close button, Esc or a click outside the video) stops the film.
document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('[data-film]')) {
    const dialog = document.getElementById(`film-${button.dataset.film}`);
    const video = dialog.querySelector('video');
    button.addEventListener('click', () => {
      if (!video.poster) video.poster = video.dataset.poster;
      dialog.showModal();
      video.play().catch(() => {
        // Autoplay refused or no playable source: the controls are there to try again.
      });
    });
    dialog.addEventListener('close', () => video.pause());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
});
