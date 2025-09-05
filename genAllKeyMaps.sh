dir="gjsosk@snry.me/keycodes"
rm -rf $dir
mkdir $dir
for i in $(localectl list-x11-keymap-layouts); do
	echo $i
	python genKeyMap.py "$i" > "$dir/$i.json"
	for j in $(localectl list-x11-keymap-variants $i 2> /dev/null); do
		echo "$i+$j"
		python genKeyMap.py "$i+$j" > "$dir/$i+$j.json"
	done; 
done;
tar -Jcvf gjsosk@snry.me/keycodes.tar.xz -C $dir/ .
rm -rf $dir
