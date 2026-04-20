$(document).ready(function() {
	'use strict';
	/*-----------------------------------------------------------------------------------*/
	/*	STICKY HEADER
	/*-----------------------------------------------------------------------------------*/
   if($("#search-input").length > 0){
   		var sjs = SimpleJekyllSearch({
       searchInput: document.getElementById('search-input'),
       resultsContainer: document.getElementById('results-container'),
       json: '/search.json'
    });
   }
   
   if ($(".navbar").length) {
    var options = {
        offset: 350, // Adjust as needed
        offsetSide: "top",
        classes: {
            clone: "banner--clone fixed",
            stick: "banner--stick",
            unstick: "banner--unstick",
        },
        onStick: function () {
            // Initialize SmartMenus if required
            $($.SmartMenus.Bootstrap.init);

            // Handle sticky cloned navigation
            $(".banner--clone").each(function () {
                var $clone = $(this);

                // Check if this specific banner--clone is inside a dark-wrapper
                if ($clone.closest(".dark-wrapper").length) {
                    // Display the white logo for dark-wrapper
                    $clone.find(".logo-light").removeClass("d-none");
                    $clone.find(".logo-dark").addClass("d-none");
                } else {
                    // Default behavior for sticky cloned navigation
                    $clone.find(".logo-light").addClass("d-none");
                    $clone.find(".logo-dark").removeClass("d-none");

                    // Ensure transparency rule does not interfere
                    $clone.find(".logo-dark").css("display", "block");
                }
            });
        },
        onUnstick: function () {
            // Close any dropdowns
            $(".search-dropdown .dropdown-menu").collapse("hide");

            // Handle sticky cloned navigation
            $(".banner--clone").each(function () {
                var $clone = $(this);

                // Check if this specific banner--clone is inside a dark-wrapper
                if ($clone.closest(".dark-wrapper").length) {
                    // Display the white logo for dark-wrapper
                    $clone.find(".logo-light").removeClass("d-none");
                    $clone.find(".logo-dark").addClass("d-none");
                } else {
                    // Default behavior for sticky cloned navigation
                    $clone.find(".logo-light").removeClass("d-none");
                    $clone.find(".logo-dark").addClass("d-none");
                }
            });

            // Handle default navigation
            var defaultLogo = $(".navbar-brand").data("default-logo") || "white"; // Default to white
            if (defaultLogo === "black") {
                $(".navbar-brand .logo-light").addClass("d-none");
                $(".navbar-brand .logo-dark").removeClass("d-none");

                // Ensure transparency rule does not interfere
                $(".navbar-brand .logo-dark").css("display", "block");
            } else {
                $(".navbar-brand .logo-light").removeClass("d-none");
                $(".navbar-brand .logo-dark").addClass("d-none");
            }
        },
    };

    // Initialize Headhesive
    var banner = new Headhesive(".navbar", options);
}
	/*-----------------------------------------------------------------------------------*/
	/*	HEADER BUTTONS
	/*-----------------------------------------------------------------------------------*/
	var $header_hamburger = $('.hamburger.animate');
	var $header_search = $('.search-dropdown .dropdown-menu');
	var $header_cart = $('.cart-dropdown .dropdown-menu');
	var $navbar_offcanvas = $('.offcanvas-nav');
	var $navbar_offcanvas_toggle = $('[data-bs-toggle="offcanvas-nav"]');
	var $navbar_offcanvas_close = $('.offcanvas-nav-close');
	var $navbar_search_toggle = $('.search-dropdown .collapse-toggle');
	var $navbar_search_close = $(".search-dropdown .dropdown-menu .dropdown-close");
	var $info_offcanvas = $('.offcanvas-info');
	var $info_offcanvas_close = $('.offcanvas-info-close');
	var $info_offcanvas_toggle = $('[data-bs-toggle="offcanvas-info"]');
	$header_hamburger.on("click", function() {
		$header_hamburger.toggleClass("active");
		$header_search.collapse('hide');
	});
	$header_search.on('click', function(e) {
		e.stopPropagation();
	});
	$navbar_search_close.click(function() {
		$header_search.collapse('hide');
	});
	$navbar_search_toggle.on('click', function(e) {
		$navbar_offcanvas.removeClass('open');
		$header_hamburger.removeClass('active');
	});
	$navbar_offcanvas_toggle.on("click", function(e) {
		e.stopPropagation();
		$navbar_offcanvas.toggleClass('open');
	});
	$navbar_offcanvas.on("click", function(e) {
		e.stopPropagation();
	});
	$header_cart.on('click', function(e) {
		e.stopPropagation();
	});
	$navbar_offcanvas_close.on("click", function(e) {
		$navbar_offcanvas.removeClass('open');
		$header_hamburger.removeClass('active');
	});
	$info_offcanvas_toggle.on("click", function(e) {
		e.stopPropagation();
		$info_offcanvas.toggleClass('open');
		$header_search.collapse('hide');
	});
	$info_offcanvas.on("click", function(e) {
		e.stopPropagation();
	});
	$(document).on('click', function() {
		$header_search.collapse('hide');
		$navbar_offcanvas.removeClass('open');
		$info_offcanvas.removeClass('open');
		$header_hamburger.removeClass('active');
	});
	$info_offcanvas_close.on("click", function(e) {
		$info_offcanvas.removeClass('open');
	});
	$('.onepage .navbar li a').on('click', function() {
		$navbar_offcanvas.removeClass('open');
		$header_hamburger.removeClass('active');
	});
	/*-----------------------------------------------------------------------------------*/
	/*	ONEPAGE NAV LINKS
	/*-----------------------------------------------------------------------------------*/
	var empty_a = $('.onepage .navbar ul.navbar-nav a[href="#"]');
	empty_a.on('click', function(e) {
		e.preventDefault();
	});
	/*-----------------------------------------------------------------------------------*/
	/*	ONEPAGE SMOOTH SCROLL
	/*-----------------------------------------------------------------------------------*/
	$(function() {
		setTimeout(function() {
			if (location.hash) {
				window.scrollTo(0, 0);
				var target = location.hash.split('#');
				smoothScrollTo($('#' + target[1]));
			}
		}, 1);
		$('a.scroll[href*="#"]:not([href="#"])').on('click', function() {
			if (location.pathname.replace(/^\//, '') == this.pathname.replace(/^\//, '') && location.hostname == this.hostname) {
				smoothScrollTo($(this.hash));
				return false;
			}
		});
		function smoothScrollTo(target) {
			if (target.length) {
				var targetPosition = target.offset().top - 90;
				$('html, body').stop().animate({
					scrollTop: targetPosition
				}, {
					duration: 800,
					easing: 'easeInOutQuart',
					complete: function() {
						// Re-enable scroll tracking after animation
						didScroll = true;
					}
				});
			}
		}
	});
	/*-----------------------------------------------------------------------------------*/
	/*	ONEPAGE SCROLL SPY
	/*-----------------------------------------------------------------------------------*/
	// Set home as active by default
	$('.navbar-nav .nav-link.scroll[href="#home"]').addClass('active');

	// Throttle scroll events for better performance
	var didScroll = false;
	$(window).on('scroll', function() {
		didScroll = true;
	});

	// Check scroll state every 100ms
	setInterval(function() {
		if (didScroll) {
			handleScroll();
			didScroll = false;
		}
	}, 100);

	function handleScroll() {
		var scrollDistance = $(window).scrollTop();

		// Assign active class to nav links while scrolling
		$('section').each(function(i) {
			if ($(this).position().top <= scrollDistance + 100) {
				$('.navbar-nav .nav-link.scroll').removeClass('active');
				$('.navbar-nav .nav-link.scroll').eq(i).addClass('active');
			}
		});

		// Make first nav item active when at top of page
		if (scrollDistance < 100) {
			$('.navbar-nav .nav-link.scroll').removeClass('active');
			$('.navbar-nav .nav-link.scroll[href="#home"]').addClass('active');
		}
	}

	// Initial check
	handleScroll();

	/*-----------------------------------------------------------------------------------*/
	/*	BACKGROUND IMAGE
	/*-----------------------------------------------------------------------------------*/
	$(".bg-image").css('background-image', function() {
		var bg = ('url(' + $(this).data("image-src") + ')');
		return bg;
	});
	/*-----------------------------------------------------------------------------------*/
	/*	IMAGE ICON HOVER
	/*-----------------------------------------------------------------------------------*/
	$('.overlay:not(.caption) > a, .overlay:not(.caption) > span, .overlay.caption-overlay > a, .overlay.caption-overlay > span').prepend('<span class="bg"></span>');
	/*-----------------------------------------------------------------------------------*/
	/*	ISOTOPE GRID
	/*-----------------------------------------------------------------------------------*/
	function enableIsotope() {
	  // for each container
	  $('.grid').each( function( i, gridContainer ) {
	    var $gridContainer = $( gridContainer );
	    // init isotope for container
	    var $grid = $gridContainer.find('.isotope').imagesLoaded( function() {
	      $grid.isotope({
	        itemSelector: '.item',
	        layoutMode: 'masonry',
	        percentPosition: true,
	        masonry: {
	            columnWidth: $grid.width() / 12
	        },
			transitionDuration: '0.7s'
	      })
	    });
			$(window).resize(function() {
				$grid.isotope({
					masonry: {
						columnWidth: $grid.width() / 12
					}
				});
			});
			$(window).on("load", function() {
				$grid.isotope({
					masonry: {
						columnWidth: $grid.width() / 12
					}
				});
			});
	    // initi filters for container
	    $gridContainer.find('.isotope-filter').on( 'click', '.button', function() {
	      var filterValue = $( this ).attr('data-filter');
	      $grid.isotope({ filter: filterValue });
	    });
	  });
	    
	  $('.isotope-filter').each( function( i, buttonGroup ) {
	    var $buttonGroup = $( buttonGroup );
	    $buttonGroup.on( 'click', '.button', function() {
	      $buttonGroup.find('.active').removeClass('active');
	      $( this ).addClass('active');
	    });
	  });
	
	};
	enableIsotope();
	/*-----------------------------------------------------------------------------------*/
	/*	OWL CAROUSEL
	/*-----------------------------------------------------------------------------------*/
	$('.basic-slider').each(function() {
		var $bslider = $(this);
		$bslider.owlCarousel({
			items: 1,
			nav: false,
			dots: true,
			dotsEach: true,
			autoHeight: true,
			loop: true,
			margin: $bslider.data("margin")
		});
	});
	$('.carousel').each(function() {
		var $carousel = $(this);
		$carousel.owlCarousel({
			autoHeight: false,
			nav: false,
			dots: $carousel.data("dots"),
			dotsEach: true,
			loop: $carousel.data("loop"),
			margin: $carousel.data("margin"),
			autoplay: $carousel.data("autoplay"),
			autoplayTimeout: $carousel.data("autoplay-timeout"),
			responsive: $carousel.data("responsive")
		});
	});
	/*-----------------------------------------------------------------------------------*/
	/*	OWL SLIDER WITH THUMBNAILS
	/*-----------------------------------------------------------------------------------*/
	var $owlmain = $(".owl-slider-main");
	var $owlnav = $(".owl-slider-nav");
	//var totalslides = 10;
	var syncedSecondary = true;
	$owlmain
		.owlCarousel({
			items: 1,
			nav: false,
			margin: 10,
			autoplay: false,
			dots: false,
			loop: true,
			responsiveRefreshRate: 200
		})
		.on("changed.owl.carousel", syncPosition);
	$owlnav
		.on("initialized.owl.carousel", function() {
			$owlnav
				.find(".owl-item")
				.eq(0)
				.addClass("current");
		})
		.owlCarousel({
			items: 3,
			margin: 10,
			dots: false,
			nav: false,
			smartSpeed: 200,
			slideSpeed: 500,
			slideBy: 3,
			responsiveRefreshRate: 100
		})
		.on("changed.owl.carousel", syncPosition2);
	function syncPosition(el) {
		//if loop is set to false, then you have to uncomment the next line
		//var current = el.item.index;
		//to disable loop, comment this block
		var count = el.item.count - 1;
		var current = Math.round(el.item.index - el.item.count / 2 - 0.5);
		if (current < 0) {
			current = count;
		}
		if (current > count) {
			current = 0;
		}
		//to this
		$owlnav
			.find(".owl-item")
			.removeClass("current")
			.eq(current)
			.addClass("current");
		var onscreen = $owlnav.find(".owl-item.active").length - 1;
		var start = $owlnav
			.find(".owl-item.active")
			.first()
			.index();
		var end = $owlnav
			.find(".owl-item.active")
			.last()
			.index();
		if (current > end) {
			$owlnav.data("owl.carousel").to(current, 100, true);
		}
		if (current < start) {
			$owlnav.data("owl.carousel").to(current - onscreen, 100, true);
		}
	}
	function syncPosition2(el) {
		if (syncedSecondary) {
			var number = el.item.index;
			$owlmain.data("owl.carousel").to(number, 100, true);
		}
	}
	$owlnav.on("click", ".owl-item", function(e) {
		e.preventDefault();
		var number = $(this).index();
		$owlmain.data("owl.carousel").to(number, 300, true);
	});
	/*-----------------------------------------------------------------------------------*/
	/*	LIGHTGALLERY
	/*-----------------------------------------------------------------------------------*/
	function enablelightGallery() {
		var $lg = $('.light-gallery-wrapper');
		$lg.lightGallery({
			thumbnail: false,
			selector: '.lightbox',
			mode: 'lg-fade',
			download: false,
			autoplayControls: false,
			zoom: false,
			fullScreen: false,
			videoMaxWidth: '1000px',
			loop: false,
			hash: false,
			mousewheel: true,
			videojs: true,
			share: false
		});
	}
	enablelightGallery();
	/*-----------------------------------------------------------------------------------*/
	/*	SLIDER REVOLUTION
	/*-----------------------------------------------------------------------------------*/
	$('#slider').revolution({
		sliderType: "standard",
		sliderLayout: "fullscreen",
		spinner: "spinner",
		dottedOverlay: 'gradient',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: true,
				style: '',
				hide_onleave: true,
				hide_onmobile: false,
				h_align: "center",
				v_align: "bottom",
				space: 8,
				h_offset: 0,
				v_offset: 20
			}
		}
	});
	$('#slider2').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 550],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: true,
				style: '',
				hide_onleave: true,
				hide_onmobile: false,
				h_align: "center",
				v_align: "bottom",
				space: 8,
				h_offset: 0,
				v_offset: 20
			}
		}
	});
	$('#slider3').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 550],
		responsiveLevels: [1240, 1024, 778, 480],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider4').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 550],
		responsiveLevels: [1240, 1124, 778, 480],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider5').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 600],
		responsiveLevels: [1240, 1124, 778, 480],
		autoHeight: 'off',
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider6').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [750, 750, 850, 750],
		responsiveLevels: [1240, 1124, 778, 480],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider7').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		responsiveLevels: [1240, 1024, 778, 480],
		gridwidth:[1240, 1024, 778, 480],
		gridheight: [750, 750, 750, 600],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider8').revolution({
		sliderType: "standard",
		sliderLayout: "fullscreen",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider9').revolution({
		sliderType: "standard",
		sliderLayout: "fullscreen",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay2',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			tabs: {
				style: 'zeus',
				enable: true,
				width: 50,
				height: 50,
				min_width: 50,
				wrapper_padding: 0,
				wrapper_color: 'none',
				wrapper_opacity: '0.5',
				tmp: '<span class="tp-tab-image"></span>',
				visibleAmount: 20,
				hide_onmobile: true,
				hide_onleave: false,
				hide_delay: 200,
				direction: 'horizontal',
				span: true,
				position: 'inner',
				space: 10,
				h_align: 'center',
				v_align: 'bottom',
				h_offset: 20,
				v_offset: 20
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider10').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'gradient',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 550],
		responsiveLevels: [1240, 1124, 778, 480],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider11').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [700, 700, 800, 600],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: '',
				left: {
					v_offset: -40
				},
				right: {
					v_offset: -40
				},
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider12').revolution({
		sliderType: "standard",
		sliderLayout: "fullscreen",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1140, 1024, 778, 480],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			mouseScrollNavigation: "on",
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'vertical',
				drag_block_vertical: true
			},
			tabs: {
				style: 'zeus',
				enable: true,
				width: 50,
				height: 50,
				min_width: 50,
				wrapper_padding: 0,
				wrapper_color: 'none',
				wrapper_opacity: '0.5',
				tmp: '<span class="tp-tab-image"></span>',
				visibleAmount: 20,
				hide_onmobile: true,
				hide_onleave: false,
				hide_delay: 200,
				direction: 'horizontal',
				span: true,
				position: 'inner',
				space: 5,
				h_align: 'left',
				v_align: 'bottom',
				h_offset: 20,
				v_offset: 20
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider13').revolution({
		sliderType: "standard",
		sliderLayout: "auto",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [650, 650, 650, 550],
		responsiveLevels: [1240, 1024, 778, 480],
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider14').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: 'darkoverlay',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [750, 750, 750, 700],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: true,
				style: '',
				hide_onleave: true,
				hide_onmobile: false,
				h_align: "center",
				v_align: "bottom",
				space: 8,
				h_offset: 0,
				v_offset: 20
			}
		}
	});
	$('#slider15').revolution({
		sliderType: "standard",
		sliderLayout: "fullscreen",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1140, 1024, 778, 480],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: false
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	$('#slider16').revolution({
		sliderType: "standard",
		sliderLayout: "fullwidth",
		fullScreenOffsetContainer: ".navbar:not(.fixed)",
		spinner: "spinner",
		dottedOverlay: '',
		delay: 9000,
		shadow: 0,
		gridwidth: [1240, 1024, 778, 480],
		gridheight: [750, 750, 750, 600],
		responsiveLevels: [1240, 1024, 778, 480],
		disableProgressBar: "on",
		navigation: {
			keyboardNavigation: 'on',
			keyboard_direction: 'horizontal',
			arrows: {
				enable: true,
				hide_onleave: true,
				hide_under: 1024,
				style: '',
				tmp: ''
			},
			touch: {
				touchenabled: 'on',
				swipe_threshold: 75,
				swipe_min_touches: 1,
				swipe_direction: 'horizontal',
				drag_block_vertical: true
			},
			bullets: {
				enable: false
			}
		}
	});
	/*-----------------------------------------------------------------------------------*/
	/*	PLYR
	/*-----------------------------------------------------------------------------------*/
	const players = Plyr.setup('.player');
	/*-----------------------------------------------------------------------------------*/
	/*	CIRCLE INFO BOX
	/*-----------------------------------------------------------------------------------*/
	$("#dial1").s8CircleInfoBox({
		autoSlide: false,
		action: "mouseover"
	});
	$("#dial2").s8CircleInfoBox({
		autoSlide: false,
		action: "mouseover"
	});
	/*-----------------------------------------------------------------------------------*/
	/*	PROGRESSBAR
	/*-----------------------------------------------------------------------------------*/
	var $pline = $('.progressbar.line');
	var $pcircle = $('.progressbar.circle');
	$pline.each(function(i) {
		var line = new ProgressBar.Line(this, {
			strokeWidth: 3,
			trailWidth: 3,
			duration: 3000,
			easing: 'easeInOut',
			text: {
				style: {
					color: 'inherit',
					position: 'absolute',
					right: '0',
					top: '-30px',
					padding: 0,
					margin: 0,
					transform: null
				},
				autoStyleContainer: false
			},
			step: function(state, line, attachment) {
				line.setText(Math.round(line.value() * 100) + ' %');
			}
		});
		var value = ($(this).attr('data-value') / 100);
		$pline.waypoint(function() {
			line.animate(value);
		}, {
			offset: "100%"
		})
	});
	$pcircle.each(function(i) {
		var circle = new ProgressBar.SemiCircle(this, {
			strokeWidth: 5,
			trailWidth: 5,
			duration: 2000,
			easing: 'easeInOut',
			step: function(state, circle, attachment) {
				circle.setText(Math.round(circle.value() * 100));
			}
		});
		var value = ($(this).attr('data-value') / 100);
		$pcircle.waypoint(function() {
			circle.animate(value);
		}, {
			offset: "100%"
		})
	});
	/*-----------------------------------------------------------------------------------*/
	/*	COUNTER UP
	/*-----------------------------------------------------------------------------------*/
	$('.counter .value').counterUp({
		delay: 50,
		time: 1000
	});
	/*-----------------------------------------------------------------------------------*/
	/*	COUNTDOWN
	/*-----------------------------------------------------------------------------------*/
	$(".countdown").countdown();
	/*-----------------------------------------------------------------------------------*/
	/*	AOS
	/*-----------------------------------------------------------------------------------*/
	AOS.init({
        easing: 'ease-in-out-sine',
        duration: 800,
        once: true
    });
	
	/*-----------------------------------------------------------------------------------*/
	/*	VIDEO WRAPPER
	/*-----------------------------------------------------------------------------------*/
	$('.video-wrapper video').backgroundVideo({
		$outerWrap: $('.video-wrapper'),
		pauseVideoOnViewLoss: false,
		parallaxOptions: {
			effect: 3
		}
	});
	/*-----------------------------------------------------------------------------------*/
	/*	CONTACT FORM
	/*-----------------------------------------------------------------------------------*/
	function enableContactForm() {
		$('#contact-form').validator({
			disable: false,
			focus: false
		});
	}
	enableContactForm();
	/*-----------------------------------------------------------------------------------*/
	/*	MODAL
	/*-----------------------------------------------------------------------------------*/
	setTimeout(function() {
		$(".modal-popup").modal("show")
	}, 200);
	$('#modal-03').on('shown.bs.modal', function() {
		enableContactForm();
	})
	/*-----------------------------------------------------------------------------------*/
	/*	PAGE LOADING
	/*-----------------------------------------------------------------------------------*/
	$('.page-loading').delay(350).fadeOut('slow');
	$('.page-loading .status').fadeOut('slow');
	/*-----------------------------------------------------------------------------------*/
	/*	IMAGE WRAPPER MOBILE
	/*-----------------------------------------------------------------------------------*/
	if (navigator.userAgent.match(/Android/i) || navigator.userAgent.match(/webOS/i) || navigator.userAgent.match(/iPhone/i) || navigator.userAgent.match(/iPad/i) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || navigator.userAgent.match(/iPod/i) || navigator.userAgent.match(/BlackBerry/i)) {
		$('.image-wrapper').addClass('mobile');
	}
	/*-----------------------------------------------------------------------------------*/
	/*	PRICING
	/*-----------------------------------------------------------------------------------*/
	$('.pricing-wrapper').each(function(i, container) {
		var $container = $(container);
		$container.find(".pricing-switcher").on('click', function() {
			$container.find(".pricing-switcher").toggleClass('pricing-switcher-active');
			$container.find(".price").removeClass('price-hidden');
			$container.find(".price").toggleClass('price-show price-hide');
		});
	});


});

/*-----------------------------------------------------------------------------------*/
	/*	TOOLTIP & POPOVER pure vanilla js code
	/*-----------------------------------------------------------------------------------*/

    document.addEventListener('DOMContentLoaded', function () {
      'use strict';
      
      // Initialize AOS (if applicable)
      if (typeof AOS !== 'undefined') {
        AOS.init({
          easing: 'ease-in-out-sine',
          duration: 800,
          once: true,
        });
      }
  
      // Initialize tooltips
      const tooltipElements = document.querySelectorAll('[data-bs-toggle="tooltip"]');
      tooltipElements.forEach((tooltipElement) => {
        new bootstrap.Tooltip(tooltipElement);
      });
  
      // Initialize popovers
      const popoverElements = document.querySelectorAll('[data-bs-toggle="popover"]');
      popoverElements.forEach((popoverElement) => {
        new bootstrap.Popover(popoverElement, {
          trigger: 'focus',
        });
      });
    });
 

  