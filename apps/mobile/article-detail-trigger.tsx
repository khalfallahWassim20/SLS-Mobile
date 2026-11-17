import {useState,type ReactNode} from 'react';
import {TouchableOpacity,type StyleProp,type ViewStyle} from 'react-native';
import type {RefArticle} from './reference';
import {ArticleDetailSheet} from './article-detail-sheet';

/** Rend une carte d'article cliquable : un appui ouvre la fiche détaillée.
 * L'état d'ouverture est local à la carte, et la fiche n'est montée que lorsqu'elle est ouverte. */
export function ArticleDetailTrigger({article,style,children}:{article:RefArticle;style?:StyleProp<ViewStyle>;children:ReactNode}) {
  const [open,setOpen]=useState(false);
  return (
    <>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Voir la fiche de ${article.name}`} activeOpacity={0.8} style={style} onPress={()=>setOpen(true)}>{children}</TouchableOpacity>
      {open&&<ArticleDetailSheet article={article} onClose={()=>setOpen(false)} />}
    </>
  );
}
