var gulp = require('gulp');
var sizereport = require('gulp-sizereport');

gulp.task('default', ['add-istanbul-ignore', 'minify'], function() {
	return gulp.src('dist/**/*')
		.pipe(sizereport({
			total: false,
			gzip: true
		}));
});
