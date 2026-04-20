## Header

Header folder consists of 8 variations of Page Header with Titles

### bg_color: 
this variable when defined on page will change the color of header (page title bckground)
it can take values as follows 
    bg-default
    bg-dark
    bg-gray
    bg-white
    bg-red
	bg-orange
	bg-yellow
	bg-green
	bg-leaf
	bg-teal
	bg-aqua
	bg-meander
	bg-blue
	bg-cobalt
	bg-sky
	bg-purple
	bg-violet
	bg-pink
	bg-rose
	bg-hibiscus
	bg-brown

## Nav

Nav folder consists of 11 variations of Navigation 
 by default the logo is set to white for classic 
 you can set black logo by following 

 	{% include navigation.html default_logo="black" logo_class="custom-logo-class" %}

for nav-10 
	{% include nav-10.html shop_header=true %}

This would include the shop-header.html partial. Similarly, you can add other combinations:

	{% include nav-10.html btn_header=true %}
	{% include nav-10.html drop_search=true %}
    <div class="navbar-brand">
      <a href="{{site.url}}">
        <!-- White Logo -->
        <img 
          src="{{site.data.general_settings.light_logo_1x}}" 
          srcset="{{site.data.general_settings.light_logo_1x}} 1x, {{site.data.general_settings.light_logo_2x}} 2x"
          class="{% if include.logo_class %}{{ include.logo_class }}{% else %}logo-light{% endif %} 
                 {% unless include.default_logo == 'black' %}{% else %}d-none{% endunless %}" 
          alt="{{site.data.general_settings.title}}" />
        
        <!-- Black Logo -->
        <img 
          src="{{site.data.general_settings.black_logo_1x}}" 
          srcset="{{site.data.general_settings.black_logo_1x}} 1x, {{site.data.general_settings.black_logo_2x}} 2x"
          class="{% if include.logo_class %}{{ include.logo_class }}{% else %}logo-dark{% endif %} 
                 {% if include.default_logo == 'black' %}{% else %}d-none{% endif %}" 
          alt="{{site.data.general_settings.title}}" />
      </a>
    </div>

Best Practice

    Use meaningful names for the class, such as center-logo, logo-with-padding, or logo-hover-effect, based on the styling applied.
    Combine multiple styles in your custom-logo-class if needed, but keep the class name descriptive.


## Footer

Footer folder consists of 8 variations of Footer 

## Blogs

The main blogs directory holds the design to blog pages and there are 8 variations of them

### header_image : 
this variable can be used to define a page title image. You can insert the path to your image in this variable.

### post_format:  
its a variable used in blog pages frontmatter to define which post type you wanna use

post_format can take the following values -- general , gallery, carousel , video

## Breadcrumbs
Usage
-----

To render the breadcrumbs for the current page:

    {% include breadcrumbs.html %}

To render the breadcrumbs for another page:

    {% include breadcrumbs.html page=another_page %}

To render breadcrumbs with the home page and date omitted (see [Options](#options) below
for more options):

    {% include breadcrumbs.html omit_home=true omit_date=true %}

Options
-------

omit_home
: Don't include the home page as the first breadcrumb.

omit_collection
: Don't include the page's collection ("posts" by default, for posts) in the breadcrumbs.

omit_categories
: Don't include the page's categories in the breadcrumbs.

omit_date
: Don't include the post's date (year, month and day) in the breadcrumbs.

omit_year
: Don't include the post's year in the breadcrumbs.

omit_month
: Don't include the post's month in the breadcrumbs.

omit_date
: Don't include the post's date in the breadcrumbs.